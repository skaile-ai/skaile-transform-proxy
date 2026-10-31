// OpenAI Responses walker: rewrites text leaves in the native JSON and SSE, nothing else.
//
// Signature cache: a reasoning item's summary texts, exactly as the model produced them, are
// stored under `responses:<itemId>` as a JSON-encoded string array. On a request, a reasoning
// item whose id is cached gets those texts back byte for byte (no outbound), so the item's
// `encrypted_content` stays consistent with its summary.
//
// Stream tails: the held-back tail of a text or summary stream is emitted as one extra `.delta`
// event just before the matching `.done` event. That event reuses the `.done` event's
// `sequence_number`; sequence numbers are never renumbered.
import type { TextLeaf, TextLeafKind, Transform } from '../contract.ts'
import { createJsonArgRestorer, type TextRestorer } from './json-args.ts'
import { createSseFramer, formatSseEvent, type SseBlock } from './sse.ts'
import { UnsupportedContentError, type SseTransformer, type WireContext, type WireWalker } from './types.ts'

type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Part types that carry attachments the proxy cannot pseudonymize. */
const REFUSED_PARTS: Readonly<Record<string, true>> = { input_image: true, input_file: true, input_audio: true }

const signatureKey = (itemId: string): string => `responses:${itemId}`

function refuse(part: Obj): void {
  if (typeof part.type === 'string' && REFUSED_PARTS[part.type] === true) {
    throw new UnsupportedContentError(`OpenAI responses ${part.type} content cannot be transformed`)
  }
}

async function outbound(transform: Transform, text: string, leaf: TextLeaf): Promise<string> {
  return text === '' ? text : transform.outbound(text, leaf)
}

/** A string, or an array of parts whose `input_text`/`output_text` parts are rewritten. */
async function rewriteContent(content: unknown, leaf: TextLeaf, transform: Transform): Promise<unknown> {
  if (typeof content === 'string') return outbound(transform, content, leaf)
  if (!Array.isArray(content)) return content
  const out: unknown[] = []
  for (const part of content) {
    if (!isObj(part)) {
      out.push(part)
      continue
    }
    refuse(part)
    out.push((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string'
      ? { ...part, text: await outbound(transform, part.text, leaf) }
      : part)
  }
  return out
}

async function rewriteStrings(value: unknown, leaf: TextLeaf, transform: Transform): Promise<unknown> {
  if (typeof value === 'string') return outbound(transform, value, leaf)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(await rewriteStrings(item, leaf, transform))
    return out
  }
  if (isObj(value)) {
    const out: Obj = {}
    for (const [key, item] of Object.entries(value)) out[key] = await rewriteStrings(item, leaf, transform)
    return out
  }
  return value
}

/** Tool-call arguments: a JSON string whose string leaves are rewritten; raw text when it is not JSON. */
async function rewriteArguments(args: string, leaf: TextLeaf, transform: Transform): Promise<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return outbound(transform, args, leaf)
  }
  return JSON.stringify(await rewriteStrings(parsed, leaf, transform))
}

/** Restores the string values of a JSON text, keeping its formatting; restored originals are JSON-escaped. */
function restoreArguments(args: string, transform: Transform): string {
  const restorer = createJsonArgRestorer(() => transform.inboundStream())
  return restorer.push(args) + restorer.flush()
}

function summaryTexts(item: Obj): string[] | undefined {
  if (!Array.isArray(item.summary)) return undefined
  const texts: string[] = []
  for (const part of item.summary) {
    if (!isObj(part) || typeof part.text !== 'string') return undefined
    texts.push(part.text)
  }
  return texts
}

function cachedSummary(item: Obj, ctx: WireContext): string[] | undefined {
  if (typeof item.id !== 'string') return undefined
  const cached = ctx.signatures.get(signatureKey(item.id))
  if (cached === undefined) return undefined
  const texts: unknown = JSON.parse(cached)
  if (!Array.isArray(texts) || !Array.isArray(item.summary) || texts.length !== item.summary.length) return undefined
  return texts as string[]
}

async function rewriteReasoning(item: Obj, ctx: WireContext): Promise<Obj> {
  if (!Array.isArray(item.summary)) return item
  const cached = cachedSummary(item, ctx)
  const summary: unknown[] = []
  for (const [i, part] of item.summary.entries()) {
    if (!isObj(part) || typeof part.text !== 'string') summary.push(part)
    else if (cached !== undefined) summary.push({ ...part, text: cached[i] })
    else summary.push({ ...part, text: await outbound(ctx.transform, part.text, { kind: 'thinking' }) })
  }
  return { ...item, summary }
}

function roleKind(role: unknown): TextLeafKind | undefined {
  if (role === 'developer' || role === 'system') return 'system'
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return undefined
}

function toolNamesByCallId(items: readonly unknown[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const item of items) {
    if (isObj(item) && item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
      names.set(item.call_id, item.name)
    }
  }
  return names
}

async function rewriteItem(item: Obj, toolNames: ReadonlyMap<string, string>, ctx: WireContext): Promise<Obj> {
  const isMessage = item.type === 'message' || (item.type === undefined && item.role !== undefined)
  if (isMessage) {
    const kind = roleKind(item.role)
    if (kind === undefined) return item
    return { ...item, content: await rewriteContent(item.content, { kind }, ctx.transform) }
  }
  switch (item.type) {
    case 'function_call': {
      if (typeof item.arguments !== 'string') return item
      const toolName = typeof item.name === 'string' ? item.name : undefined
      return { ...item, arguments: await rewriteArguments(item.arguments, { kind: 'toolCall', toolName }, ctx.transform) }
    }
    case 'function_call_output': {
      const toolName = typeof item.call_id === 'string' ? toolNames.get(item.call_id) : undefined
      return { ...item, output: await rewriteContent(item.output, { kind: 'toolResult', toolName }, ctx.transform) }
    }
    case 'reasoning':
      return rewriteReasoning(item, ctx)
    default:
      return item
  }
}

/** Restores one output item; reasoning items store their raw summary in the signature cache first. */
function restoreItem(item: unknown, ctx: WireContext): unknown {
  if (!isObj(item)) return item
  const transform = ctx.transform
  switch (item.type) {
    case 'message':
      if (!Array.isArray(item.content)) return item
      return { ...item, content: item.content.map((part: unknown) => restorePart(part, transform)) }
    case 'reasoning': {
      const texts = summaryTexts(item)
      if (texts === undefined) return item
      if (typeof item.id === 'string') ctx.signatures.set(signatureKey(item.id), JSON.stringify(texts))
      return { ...item, summary: (item.summary as Obj[]).map((part) => ({ ...part, text: transform.inbound(part.text as string) })) }
    }
    case 'function_call':
      return typeof item.arguments === 'string' ? { ...item, arguments: restoreArguments(item.arguments, transform) } : item
    default:
      return item
  }
}

function restorePart(part: unknown, transform: Transform): unknown {
  return isObj(part) && part.type === 'output_text' && typeof part.text === 'string'
    ? { ...part, text: transform.inbound(part.text) }
    : part
}

function restoreResponse(body: Obj, ctx: WireContext): Obj {
  const out: Obj = { ...body }
  if (Array.isArray(body.output)) out.output = body.output.map((item: unknown) => restoreItem(item, ctx))
  if (typeof body.output_text === 'string') out.output_text = ctx.transform.inbound(body.output_text)
  return out
}

interface StreamState {
  readonly restore: TextRestorer
}

function createStreamTransformer(ctx: WireContext): SseTransformer {
  const streams = new Map<string, StreamState>()

  const open = (key: string, factory: () => TextRestorer): StreamState => {
    let state = streams.get(key)
    if (state === undefined) {
      state = { restore: factory() }
      streams.set(key, state)
    }
    return state
  }

  /** Emits the tail delta (if any) followed by the rewritten `.done` event. */
  const closeWith = (block: SseBlock, payload: Obj, key: string, deltaType: string, done: Obj): string => {
    const state = streams.get(key)
    streams.delete(key)
    let out = ''
    const tail = state?.restore.flush() ?? ''
    if (tail !== '') {
      const { text: _text, arguments: _args, ...rest } = payload
      out += formatSseEvent(block.event === undefined ? undefined : deltaType, { ...rest, type: deltaType, delta: tail })
    }
    return out + formatSseEvent(block.event, done)
  }

  const handle = (block: SseBlock): string => {
    let payload: unknown
    try {
      payload = JSON.parse(block.data)
    } catch {
      return block.raw
    }
    if (!isObj(payload)) return block.raw
    const itemId = typeof payload.item_id === 'string' ? payload.item_id : undefined
    const textKey = `text:${itemId}:${String(payload.content_index)}`
    const summaryKey = `summary:${itemId}:${String(payload.summary_index)}`
    const argsKey = `args:${itemId}`
    const textStream = () => ctx.transform.inboundStream()
    const argStream = () => createJsonArgRestorer(() => ctx.transform.inboundStream())

    switch (payload.type) {
      case 'response.output_text.delta':
        if (itemId === undefined || typeof payload.delta !== 'string') return block.raw
        return formatSseEvent(block.event, { ...payload, delta: open(textKey, textStream).restore.push(payload.delta) })
      case 'response.reasoning_summary_text.delta':
        if (itemId === undefined || typeof payload.delta !== 'string') return block.raw
        return formatSseEvent(block.event, { ...payload, delta: open(summaryKey, textStream).restore.push(payload.delta) })
      case 'response.function_call_arguments.delta':
        if (itemId === undefined || typeof payload.delta !== 'string') return block.raw
        return formatSseEvent(block.event, { ...payload, delta: open(argsKey, argStream).restore.push(payload.delta) })
      case 'response.output_text.done':
        if (itemId === undefined || typeof payload.text !== 'string') return block.raw
        return closeWith(block, payload, textKey, 'response.output_text.delta', { ...payload, text: ctx.transform.inbound(payload.text) })
      case 'response.reasoning_summary_text.done':
        if (itemId === undefined || typeof payload.text !== 'string') return block.raw
        return closeWith(block, payload, summaryKey, 'response.reasoning_summary_text.delta', { ...payload, text: ctx.transform.inbound(payload.text) })
      case 'response.function_call_arguments.done':
        if (itemId === undefined || typeof payload.arguments !== 'string') return block.raw
        return closeWith(block, payload, argsKey, 'response.function_call_arguments.delta', {
          ...payload,
          arguments: restoreArguments(payload.arguments, ctx.transform),
        })
      case 'response.content_part.done':
        return isObj(payload.part) ? formatSseEvent(block.event, { ...payload, part: restorePart(payload.part, ctx.transform) }) : block.raw
      case 'response.reasoning_summary_part.done':
        return isObj(payload.part) && typeof payload.part.text === 'string'
          ? formatSseEvent(block.event, { ...payload, part: { ...payload.part, text: ctx.transform.inbound(payload.part.text) } })
          : block.raw
      case 'response.output_item.done':
        return isObj(payload.item) ? formatSseEvent(block.event, { ...payload, item: restoreItem(payload.item, ctx) }) : block.raw
      case 'response.completed':
      case 'response.incomplete':
        return isObj(payload.response) ? formatSseEvent(block.event, { ...payload, response: restoreResponse(payload.response, ctx) }) : block.raw
      default:
        return block.raw
    }
  }

  const finish = (): string => {
    let out = ''
    for (const [key, state] of streams) {
      const tail = state.restore.flush()
      if (tail === '') continue
      const [kind, itemId] = key.split(':')
      const type = kind === 'text' ? 'response.output_text.delta'
        : kind === 'summary' ? 'response.reasoning_summary_text.delta'
        : 'response.function_call_arguments.delta'
      out += formatSseEvent(type, { type, item_id: itemId, delta: tail })
    }
    streams.clear()
    return out
  }

  return createSseFramer(handle, finish)
}

export const openaiResponsesWalker: WireWalker = {
  async request(body: unknown, ctx: WireContext): Promise<unknown> {
    if (!isObj(body)) return body
    const out: Obj = { ...body }
    if (typeof body.instructions === 'string') {
      out.instructions = await outbound(ctx.transform, body.instructions, { kind: 'system' })
    }
    const instruction = ctx.transform.instruction
    if (instruction !== undefined) {
      out.instructions = typeof out.instructions === 'string' && out.instructions !== ''
        ? `${instruction}\n\n${out.instructions}`
        : instruction
    }
    if (typeof body.input === 'string') {
      out.input = await outbound(ctx.transform, body.input, { kind: 'user' })
    } else if (Array.isArray(body.input)) {
      const toolNames = toolNamesByCallId(body.input)
      const input: unknown[] = []
      for (const item of body.input) input.push(isObj(item) ? await rewriteItem(item, toolNames, ctx) : item)
      out.input = input
    }
    return out
  },

  response(body: unknown, ctx: WireContext): unknown {
    return isObj(body) ? restoreResponse(body, ctx) : body
  },

  stream(ctx: WireContext): SseTransformer {
    return createStreamTransformer(ctx)
  },
}
