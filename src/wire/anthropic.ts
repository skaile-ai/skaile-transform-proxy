// Anthropic Messages walker: rewrites text leaves in the native JSON and SSE, nothing else.
import type { TextLeaf, TextLeafKind, Transform } from '../contract.ts'
import { createJsonArgRestorer, type TextRestorer } from './json-args.ts'
import { createSseFramer, formatSseEvent, type SseBlock } from './sse.ts'
import { UnsupportedContentError, type SseTransformer, type WireContext, type WireWalker } from './types.ts'

type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Block types that carry attachments the proxy cannot pseudonymize. */
const REFUSED_BLOCKS: Readonly<Record<string, true>> = { image: true, document: true, search_result: true }

const signatureKey = (signature: string): string => `anthropic:${signature}`

function refuse(block: Obj): void {
  if (typeof block.type === 'string' && REFUSED_BLOCKS[block.type] === true) {
    throw new UnsupportedContentError(`Anthropic ${block.type} content cannot be transformed`)
  }
}

/** A slot the walker reads holds a value it cannot classify: refused, never forwarded untransformed. */
function malformed(slot: string): never {
  throw new UnsupportedContentError(`Anthropic ${slot} has an unexpected shape`)
}

async function outbound(transform: Transform, text: string, leaf: TextLeaf): Promise<string> {
  return text === '' ? text : transform.outbound(text, leaf)
}

/** A string, or an array of blocks whose `text` blocks are rewritten; anything else is refused. */
async function rewriteText(content: unknown, slot: string, leaf: TextLeaf, transform: Transform): Promise<unknown> {
  if (typeof content === 'string') return outbound(transform, content, leaf)
  if (!Array.isArray(content)) return malformed(slot)
  const out: unknown[] = []
  for (const block of content) {
    if (!isObj(block)) return malformed(`${slot} block`)
    refuse(block)
    if (block.type !== 'text') {
      out.push(block)
      continue
    }
    if (typeof block.text !== 'string') return malformed(`${slot} text block`)
    out.push({ ...block, text: await outbound(transform, block.text, leaf) })
  }
  return out
}

/** Every string leaf of a JSON value (tool-call input); keys stay as they are. */
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

/** Every string leaf of a JSON value, restored inbound. */
function restoreStrings(value: unknown, transform: Transform): unknown {
  if (typeof value === 'string') return transform.inbound(value)
  if (Array.isArray(value)) return value.map((item) => restoreStrings(item, transform))
  if (isObj(value)) {
    const out: Obj = {}
    for (const [key, item] of Object.entries(value)) out[key] = restoreStrings(item, transform)
    return out
  }
  return value
}

/** A thinking block: swaps in the cached model text when its signature is known, else rewrites it. */
async function rewriteThinking(block: Obj, ctx: WireContext): Promise<Obj> {
  if (typeof block.thinking !== 'string') return malformed('thinking block')
  if (typeof block.signature === 'string') {
    const cached = ctx.signatures.get(signatureKey(block.signature))
    if (cached !== undefined) return { ...block, thinking: cached }
  }
  return { ...block, thinking: await outbound(ctx.transform, block.thinking, { kind: 'thinking' }) }
}

async function rewriteContent(content: unknown, role: unknown, toolNames: ReadonlyMap<string, string>, ctx: WireContext): Promise<unknown> {
  const textKind: TextLeafKind = role === 'assistant' ? 'assistant' : 'user'
  if (typeof content === 'string') return outbound(ctx.transform, content, { kind: textKind })
  if (!Array.isArray(content)) return malformed('message content')
  const out: unknown[] = []
  for (const block of content) {
    if (!isObj(block)) return malformed('message content block')
    refuse(block)
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string') return malformed('text block')
        out.push({ ...block, text: await outbound(ctx.transform, block.text, { kind: textKind }) })
        break
      case 'thinking':
        out.push(await rewriteThinking(block, ctx))
        break
      case 'tool_use': {
        const toolName = typeof block.name === 'string' ? block.name : undefined
        out.push({ ...block, input: await rewriteStrings(block.input, { kind: 'toolCall', toolName }, ctx.transform) })
        break
      }
      case 'tool_result': {
        // `content` is optional: a tool result without one carries no text.
        if (block.content === undefined) {
          out.push(block)
          break
        }
        const toolName = typeof block.tool_use_id === 'string' ? toolNames.get(block.tool_use_id) : undefined
        out.push({ ...block, content: await rewriteText(block.content, 'tool_result content', { kind: 'toolResult', toolName }, ctx.transform) })
        break
      }
      default:
        // Unknown block types pass through (documented deviation); attachments were refused above.
        out.push(block)
    }
  }
  return out
}

/** Maps each `tool_use` id to its tool name, so tool results can name their tool. */
function toolNamesById(messages: readonly unknown[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (!isObj(message) || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (isObj(block) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        names.set(block.id, block.name)
      }
    }
  }
  return names
}

/**
 * Appends the instruction after the host's system prompt. Gateways that serve only Claude Code
 * traffic check that the system prompt starts with the Claude Code blocks (TeamClaude answers
 * 429 for Sonnet otherwise), so the host's leading blocks must stay first.
 */
function withInstruction(system: unknown, instruction: string): unknown {
  if (system === undefined) return instruction
  if (typeof system === 'string') return `${system}\n\n${instruction}`
  if (Array.isArray(system)) return [...system, { type: 'text', text: instruction }]
  return system
}

/** Restorer for one streamed content block, by block type. */
interface BlockState {
  readonly kind: 'text' | 'thinking' | 'tool'
  readonly restore: TextRestorer
  /** Thinking only: the text exactly as the model produced it, kept for the signature cache. */
  raw: string
}

function newBlockState(kind: BlockState['kind'], transform: Transform): BlockState {
  const restore = kind === 'tool'
    ? createJsonArgRestorer(() => transform.inboundStream())
    : transform.inboundStream()
  return { kind, restore, raw: '' }
}

/** The delta that carries a block's held-back tail, shaped for the block's kind. */
function tailDelta(kind: BlockState['kind'], tail: string): Obj {
  if (kind === 'text') return { type: 'text_delta', text: tail }
  if (kind === 'thinking') return { type: 'thinking_delta', thinking: tail }
  return { type: 'input_json_delta', partial_json: tail }
}

function createStreamTransformer(ctx: WireContext): SseTransformer {
  const blocks = new Map<number, BlockState>()

  const handle = (block: SseBlock): string => {
    let payload: unknown
    try {
      payload = JSON.parse(block.data)
    } catch {
      return block.raw
    }
    if (!isObj(payload)) return block.raw
    const index = typeof payload.index === 'number' ? payload.index : undefined

    switch (payload.type) {
      case 'content_block_start': {
        const content = payload.content_block
        if (index === undefined || !isObj(content)) return block.raw
        if (content.type === 'text' || content.type === 'thinking' || content.type === 'tool_use') {
          const kind = content.type === 'tool_use' ? 'tool' : content.type
          blocks.set(index, newBlockState(kind, ctx.transform))
        }
        return block.raw
      }
      case 'content_block_delta': {
        const state = index === undefined ? undefined : blocks.get(index)
        const delta = payload.delta
        if (state === undefined || !isObj(delta)) return block.raw
        if (state.kind === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
          return formatSseEvent(block.event, { ...payload, delta: { ...delta, text: state.restore.push(delta.text) } })
        }
        if (state.kind === 'thinking' && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          state.raw += delta.thinking
          return formatSseEvent(block.event, { ...payload, delta: { ...delta, thinking: state.restore.push(delta.thinking) } })
        }
        if (state.kind === 'thinking' && delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          ctx.signatures.set(signatureKey(delta.signature), state.raw)
          return block.raw
        }
        if (state.kind === 'tool' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          return formatSseEvent(block.event, { ...payload, delta: { ...delta, partial_json: state.restore.push(delta.partial_json) } })
        }
        return block.raw
      }
      case 'content_block_stop': {
        const state = index === undefined ? undefined : blocks.get(index)
        if (index === undefined || state === undefined) return block.raw
        blocks.delete(index)
        const tail = state.restore.flush()
        if (tail === '') return block.raw
        return formatSseEvent('content_block_delta', { type: 'content_block_delta', index, delta: tailDelta(state.kind, tail) }) + block.raw
      }
      default:
        return block.raw
    }
  }

  const finish = (): string => {
    let out = ''
    for (const [index, state] of blocks) {
      const tail = state.restore.flush()
      if (tail !== '') out += formatSseEvent('content_block_delta', { type: 'content_block_delta', index, delta: tailDelta(state.kind, tail) })
    }
    blocks.clear()
    return out
  }

  return createSseFramer(handle, finish)
}

export const anthropicWalker: WireWalker = {
  async request(body: unknown, ctx: WireContext): Promise<unknown> {
    if (!isObj(body)) return malformed('request body')
    const out: Obj = { ...body }
    if (body.system !== undefined) out.system = await rewriteText(body.system, 'system', { kind: 'system' }, ctx.transform)
    if (ctx.transform.instruction !== undefined) out.system = withInstruction(out.system, ctx.transform.instruction)
    if (body.messages !== undefined) {
      if (!Array.isArray(body.messages)) return malformed('messages')
      const toolNames = toolNamesById(body.messages)
      const messages: unknown[] = []
      for (const message of body.messages) {
        if (!isObj(message)) return malformed('message')
        messages.push({ ...message, content: await rewriteContent(message.content, message.role, toolNames, ctx) })
      }
      out.messages = messages
    }
    return out
  },

  response(body: unknown, ctx: WireContext): unknown {
    if (!isObj(body) || !Array.isArray(body.content)) return body
    const content = body.content.map((block: unknown) => {
      if (!isObj(block)) return block
      if (block.type === 'text' && typeof block.text === 'string') {
        return { ...block, text: ctx.transform.inbound(block.text) }
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        if (typeof block.signature === 'string') ctx.signatures.set(signatureKey(block.signature), block.thinking)
        return { ...block, thinking: ctx.transform.inbound(block.thinking) }
      }
      if (block.type === 'tool_use') return { ...block, input: restoreStrings(block.input, ctx.transform) }
      return block
    })
    return { ...body, content }
  },

  stream(ctx: WireContext): SseTransformer {
    return createStreamTransformer(ctx)
  },
}
