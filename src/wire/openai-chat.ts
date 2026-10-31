// OpenAI chat completions walker: rewrites text leaves in the native JSON and SSE, nothing else.
// The pipeline instruction goes into a separate leading `system` message, so the host's own
// system/developer messages stay as they are (apart from their own leaf rewrite).
import type { TextLeaf, Transform } from '../contract.ts'
import { createJsonArgRestorer, type TextRestorer } from './json-args.ts'
import { createSseFramer, formatSseEvent, type SseBlock } from './sse.ts'
import { UnsupportedContentError, type SseTransformer, type WireContext, type WireWalker } from './types.ts'

type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Content part types that carry attachments the proxy cannot pseudonymize. */
const REFUSED_PARTS: Readonly<Record<string, true>> = { image_url: true, input_audio: true, file: true }

/** Reasoning fields used by OpenAI-compatible providers. */
const REASONING_FIELDS = ['reasoning_content', 'reasoning'] as const

async function outbound(transform: Transform, text: string, leaf: TextLeaf): Promise<string> {
  return text === '' ? text : transform.outbound(text, leaf)
}

/** A string, or an array of parts whose `text` parts are rewritten. */
async function rewriteContent(content: unknown, leaf: TextLeaf, transform: Transform): Promise<unknown> {
  if (typeof content === 'string') return outbound(transform, content, leaf)
  if (!Array.isArray(content)) return content
  const out: unknown[] = []
  for (const part of content) {
    if (!isObj(part)) {
      out.push(part)
      continue
    }
    if (typeof part.type === 'string' && REFUSED_PARTS[part.type] === true) {
      throw new UnsupportedContentError(`OpenAI chat ${part.type} content cannot be transformed`)
    }
    out.push(part.type === 'text' && typeof part.text === 'string'
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

/** Tool-call arguments are a JSON string: rewrite its string leaves, or the raw text when it is not JSON. */
async function rewriteArguments(args: string, leaf: TextLeaf, transform: Transform): Promise<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return outbound(transform, args, leaf)
  }
  return JSON.stringify(await rewriteStrings(parsed, leaf, transform))
}

function restoreArguments(args: string, transform: Transform): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return transform.inbound(args)
  }
  return JSON.stringify(restoreStrings(parsed, transform))
}

async function rewriteToolCalls(calls: unknown, transform: Transform, names: Map<string, string>): Promise<unknown> {
  if (!Array.isArray(calls)) return calls
  const out: unknown[] = []
  for (const call of calls) {
    if (!isObj(call) || !isObj(call.function)) {
      out.push(call)
      continue
    }
    const fn = call.function
    const toolName = typeof fn.name === 'string' ? fn.name : undefined
    if (typeof call.id === 'string' && toolName !== undefined) names.set(call.id, toolName)
    out.push(typeof fn.arguments === 'string'
      ? { ...call, function: { ...fn, arguments: await rewriteArguments(fn.arguments, { kind: 'toolCall', toolName }, transform) } }
      : call)
  }
  return out
}

async function rewriteMessage(message: Obj, transform: Transform, names: Map<string, string>): Promise<Obj> {
  const out: Obj = { ...message }
  switch (message.role) {
    case 'system':
    case 'developer':
      out.content = await rewriteContent(message.content, { kind: 'system' }, transform)
      break
    case 'user':
      out.content = await rewriteContent(message.content, { kind: 'user' }, transform)
      break
    case 'assistant':
      for (const field of REASONING_FIELDS) {
        const value = message[field]
        if (typeof value === 'string') out[field] = await outbound(transform, value, { kind: 'thinking' })
      }
      out.content = await rewriteContent(message.content, { kind: 'assistant' }, transform)
      out.tool_calls = await rewriteToolCalls(message.tool_calls, transform, names)
      if (message.tool_calls === undefined) delete out.tool_calls
      break
    case 'tool': {
      const toolName = typeof message.tool_call_id === 'string' ? names.get(message.tool_call_id) : undefined
      out.content = await rewriteContent(message.content, { kind: 'toolResult', toolName }, transform)
      break
    }
    default:
      return message
  }
  if (message.content === undefined) delete out.content
  return out
}

/** Restorers for one streamed choice. */
interface ChoiceState {
  content?: TextRestorer
  reasoning: Map<string, TextRestorer>
  tools: Map<number, TextRestorer>
}

/** The delta carrying every held tail of one choice, or undefined when nothing is held. */
function flushChoice(state: ChoiceState): Obj | undefined {
  const delta: Obj = {}
  if (state.content !== undefined) {
    const tail = state.content.flush()
    if (tail !== '') delta.content = tail
  }
  for (const [field, restore] of state.reasoning) {
    const tail = restore.flush()
    if (tail !== '') delta[field] = tail
  }
  const tools: Obj[] = []
  for (const [index, restore] of state.tools) {
    const tail = restore.flush()
    if (tail !== '') tools.push({ index, function: { arguments: tail } })
  }
  if (tools.length > 0) delta.tool_calls = tools
  state.content = undefined
  state.reasoning.clear()
  state.tools.clear()
  return Object.keys(delta).length === 0 ? undefined : delta
}

function createStreamTransformer(ctx: WireContext): SseTransformer {
  const choices = new Map<number, ChoiceState>()
  /** The latest chunk's envelope (id, model, ...), reused for tail chunks. */
  let envelope: Obj = { object: 'chat.completion.chunk' }

  const choiceState = (index: number): ChoiceState => {
    let state = choices.get(index)
    if (state === undefined) {
      state = { reasoning: new Map(), tools: new Map() }
      choices.set(index, state)
    }
    return state
  }

  const tailEvent = (event: string | undefined, index: number, delta: Obj): string =>
    formatSseEvent(event, { ...envelope, choices: [{ index, delta, finish_reason: null }] })

  const flushAll = (event: string | undefined): string => {
    let out = ''
    for (const [index, state] of choices) {
      const delta = flushChoice(state)
      if (delta !== undefined) out += tailEvent(event, index, delta)
    }
    choices.clear()
    return out
  }

  const rewriteDelta = (delta: Obj, state: ChoiceState): { delta: Obj; changed: boolean } => {
    const out: Obj = { ...delta }
    let changed = false
    if (typeof delta.content === 'string') {
      state.content ??= ctx.transform.inboundStream()
      out.content = state.content.push(delta.content)
      changed = true
    }
    for (const field of REASONING_FIELDS) {
      const value = delta[field]
      if (typeof value !== 'string') continue
      let restore = state.reasoning.get(field)
      if (restore === undefined) {
        restore = ctx.transform.inboundStream()
        state.reasoning.set(field, restore)
      }
      out[field] = restore.push(value)
      changed = true
    }
    if (Array.isArray(delta.tool_calls)) {
      out.tool_calls = delta.tool_calls.map((call: unknown) => {
        if (!isObj(call) || !isObj(call.function) || typeof call.function.arguments !== 'string') return call
        const index = typeof call.index === 'number' ? call.index : 0
        let restore = state.tools.get(index)
        if (restore === undefined) {
          restore = createJsonArgRestorer(() => ctx.transform.inboundStream())
          state.tools.set(index, restore)
        }
        changed = true
        return { ...call, function: { ...call.function, arguments: restore.push(call.function.arguments) } }
      })
    }
    return { delta: out, changed }
  }

  const handle = (block: SseBlock): string => {
    if (block.data.trim() === '[DONE]') return flushAll(block.event) + block.raw
    let payload: unknown
    try {
      payload = JSON.parse(block.data)
    } catch {
      return block.raw
    }
    if (!isObj(payload) || !Array.isArray(payload.choices)) return block.raw
    const { choices: _choices, ...rest } = payload
    envelope = rest

    let changed = false
    let before = ''
    const rewritten = payload.choices.map((choice: unknown) => {
      if (!isObj(choice)) return choice
      const index = typeof choice.index === 'number' ? choice.index : 0
      const state = choiceState(index)
      let next: Obj = choice
      if (isObj(choice.delta)) {
        const result = rewriteDelta(choice.delta, state)
        if (result.changed) {
          next = { ...choice, delta: result.delta }
          changed = true
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        const tail = flushChoice(state)
        choices.delete(index)
        if (tail !== undefined) before += tailEvent(block.event, index, tail)
      }
      return next
    })
    return before + (changed ? formatSseEvent(block.event, { ...payload, choices: rewritten }) : block.raw)
  }

  return createSseFramer(handle, () => flushAll(undefined))
}

export const openaiChatWalker: WireWalker = {
  async request(body: unknown, ctx: WireContext): Promise<unknown> {
    if (!isObj(body)) return body
    const out: Obj = { ...body }
    if (Array.isArray(body.messages)) {
      const names = new Map<string, string>()
      const messages: unknown[] = []
      for (const message of body.messages) {
        messages.push(isObj(message) ? await rewriteMessage(message, ctx.transform, names) : message)
      }
      if (ctx.transform.instruction !== undefined) messages.unshift({ role: 'system', content: ctx.transform.instruction })
      out.messages = messages
    }
    return out
  },

  response(body: unknown, ctx: WireContext): unknown {
    if (!isObj(body) || !Array.isArray(body.choices)) return body
    const choices = body.choices.map((choice: unknown) => {
      if (!isObj(choice) || !isObj(choice.message)) return choice
      const message: Obj = { ...choice.message }
      if (typeof message.content === 'string') message.content = ctx.transform.inbound(message.content)
      for (const field of REASONING_FIELDS) {
        const value = message[field]
        if (typeof value === 'string') message[field] = ctx.transform.inbound(value)
      }
      if (Array.isArray(message.tool_calls)) {
        message.tool_calls = message.tool_calls.map((call: unknown) => {
          if (!isObj(call) || !isObj(call.function) || typeof call.function.arguments !== 'string') return call
          return { ...call, function: { ...call.function, arguments: restoreArguments(call.function.arguments, ctx.transform) } }
        })
      }
      return { ...choice, message }
    })
    return { ...body, choices }
  },

  stream(ctx: WireContext): SseTransformer {
    return createStreamTransformer(ctx)
  },
}
