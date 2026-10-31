import { describe, expect, test } from 'bun:test'
import type { TextLeaf, Transform } from '../src/contract.ts'
import { anthropicWalker } from '../src/wire/anthropic.ts'
import { UnsupportedContentError, type WireContext } from '../src/wire/types.ts'

// Fake transform: two reversible pairs. Originals and placeholders hold no JSON escape characters
// except the second original, which exercises escaping in streamed tool arguments.
const PAIRS: readonly { orig: string; ph: string }[] = [
  { orig: 'Lena', ph: 'PSEUDO_A' },
  { orig: 'say "hi"', ph: 'PSEUDO_B' },
]

function anonymize(text: string): string {
  return PAIRS.reduce((acc, p) => acc.split(p.orig).join(p.ph), text)
}

function restore(text: string): string {
  return PAIRS.reduce((acc, p) => acc.split(p.ph).join(p.orig), text)
}

/** Length of the longest suffix of `text` that is a proper prefix of a placeholder. */
function heldSuffix(text: string): number {
  let held = 0
  for (const p of PAIRS) {
    for (let k = Math.min(text.length, p.ph.length - 1); k > held; k--) {
      if (text.endsWith(p.ph.slice(0, k))) {
        held = k
        break
      }
    }
  }
  return held
}

function streamRestorer(): { push(chunk: string): string; flush(): string } {
  let held = ''
  return {
    push(chunk: string): string {
      const text = held + chunk
      const keep = heldSuffix(text)
      held = text.slice(text.length - keep)
      return restore(text.slice(0, text.length - keep))
    },
    flush(): string {
      const out = restore(held)
      held = ''
      return out
    },
  }
}

function fakeTransform(calls: { text: string; leaf: TextLeaf }[] = []): Transform {
  return {
    instruction: 'INSTR',
    async outbound(text, leaf) {
      calls.push({ text, leaf })
      return anonymize(text)
    },
    inbound: restore,
    inboundStream: streamRestorer,
  }
}

function context(calls?: { text: string; leaf: TextLeaf }[]): WireContext {
  return { transform: fakeTransform(calls), signatures: new Map() }
}

const sse = (events: readonly [string, unknown][]): string =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')

/** Feeds the chunks through a fresh transformer and returns the whole output. */
function run(ctx: WireContext, chunks: readonly string[]): string {
  const transformer = anthropicWalker.stream(ctx)
  let out = ''
  for (const chunk of chunks) out += transformer.push(chunk)
  return out + transformer.flush()
}

/** The data payloads of an SSE output, in order. */
function payloads(out: string): Record<string, unknown>[] {
  return out
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const line = block.split('\n').find((l) => l.startsWith('data: '))
      return JSON.parse(line?.slice(6) ?? 'null') as Record<string, unknown>
    })
}

function streamedText(out: string): string {
  return payloads(out)
    .map((p) => {
      const delta = p.delta as Record<string, unknown> | undefined
      return typeof delta?.text === 'string' ? delta.text : ''
    })
    .join('')
}

const TEXT_STREAM = sse([
  ['message_start', { type: 'message_start', message: { id: 'm1', content: [] } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hallo PSEU' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DO_A, bye' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_stop', { type: 'message_stop' }],
])

describe('anthropic request', () => {
  test('rewrites every text leaf with its kind and tool name, adds the instruction, keeps other fields', async () => {
    const calls: { text: string; leaf: TextLeaf }[] = []
    const body = {
      model: 'claude-x',
      max_tokens: 10,
      metadata: { user_id: 'Lena' },
      tools: [{ name: 'lookup', description: 'Lena', input_schema: { type: 'object' } }],
      system: 'You help Lena.',
      messages: [
        { role: 'user', content: 'Hi, I am Lena' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Lena thinks', signature: 'SIG1' },
            { type: 'text', text: 'Hello Lena' },
            { type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'Lena', n: 3 } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'found Lena' }] }] },
      ],
    }
    const original = structuredClone(body)
    const out = await anthropicWalker.request(body, context(calls)) as typeof body

    expect(body).toEqual(original)
    expect(out.system).toBe('INSTR\n\nYou help PSEUDO_A.')
    expect(out.messages[0]?.content).toBe('Hi, I am PSEUDO_A')
    expect(out.messages[1]?.content).toEqual([
      { type: 'thinking', thinking: 'PSEUDO_A thinks', signature: 'SIG1' },
      { type: 'text', text: 'Hello PSEUDO_A' },
      { type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'PSEUDO_A', n: 3 } },
    ])
    expect(out.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'found PSEUDO_A' }] },
    ])
    expect(out.tools).toEqual(body.tools)
    expect(out.metadata).toEqual(body.metadata)
    expect(calls.map((c) => c.leaf)).toEqual([
      { kind: 'system' },
      { kind: 'user' },
      { kind: 'thinking' },
      { kind: 'assistant' },
      { kind: 'toolCall', toolName: 'lookup' },
      { kind: 'toolResult', toolName: 'lookup' },
    ])
  })

  test('an absent system prompt becomes the instruction alone', async () => {
    const ctx = context()
    const bare: unknown = { messages: [{ role: 'user', content: 'hi' }] }
    expect(await anthropicWalker.request(bare, ctx)).toEqual({ messages: [{ role: 'user', content: 'hi' }], system: 'INSTR' })
  })

  test('prepends the instruction as a text block to an array system prompt', async () => {
    const body = { system: [{ type: 'text', text: 'Lena rules', cache_control: { type: 'ephemeral' } }], messages: [] }
    const out = await anthropicWalker.request(body, context()) as { system: unknown[] }
    expect(out.system).toEqual([
      { type: 'text', text: 'INSTR' },
      { type: 'text', text: 'PSEUDO_A rules', cache_control: { type: 'ephemeral' } },
    ])
  })

  test('a thinking block whose signature is cached is sent back with the cached model text, unrewritten', async () => {
    const calls: { text: string; leaf: TextLeaf }[] = []
    const ctx = context(calls)
    ctx.signatures.set('anthropic:SIG9', 'PSEUDO_A thinks')
    const body = {
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Lena thinks', signature: 'SIG9' }] }],
    }
    const out = await anthropicWalker.request(body, ctx) as { messages: { content: unknown[] }[] }
    expect(out.messages[0]?.content).toEqual([{ type: 'thinking', thinking: 'PSEUDO_A thinks', signature: 'SIG9' }])
    expect(calls).toEqual([])
  })

  test('a thinking block with an unknown signature is rewritten and keeps its signature', async () => {
    const body = {
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Lena thinks', signature: 'UNKNOWN' }] }],
    }
    const out = await anthropicWalker.request(body, context()) as { messages: { content: unknown[] }[] }
    expect(out.messages[0]?.content).toEqual([{ type: 'thinking', thinking: 'PSEUDO_A thinks', signature: 'UNKNOWN' }])
  })

  test('redacted_thinking is forwarded untouched', async () => {
    const body = { messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'Lena-ENC' }] }] }
    expect(await anthropicWalker.request(body, context())).toEqual({ ...body, system: 'INSTR' })
  })

  test.each([
    ['image', { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }],
    ['document', { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Lena' } }],
    ['search_result', { type: 'search_result', source: 'x', title: 't', content: [] }],
  ])('refuses %s content with unsupported_content', async (_name, block) => {
    const body = { messages: [{ role: 'user', content: [block] }] }
    const error = await anthropicWalker.request(body, context()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UnsupportedContentError)
    expect((error as UnsupportedContentError).code).toBe('unsupported_content')
  })

  test('refuses an image nested in a tool result', async () => {
    const body = {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: {} }] }],
      }],
    }
    await expect(anthropicWalker.request(body, context())).rejects.toBeInstanceOf(UnsupportedContentError)
  })
})

describe('anthropic response (JSON)', () => {
  test('restores text, thinking and tool-call input; caches the thinking under its signature', () => {
    const ctx = context()
    const body = {
      id: 'msg_1',
      type: 'message',
      content: [
        { type: 'thinking', thinking: 'PSEUDO_A thinks', signature: 'SIG3' },
        { type: 'redacted_thinking', data: 'ENC' },
        { type: 'text', text: 'Hi PSEUDO_A' },
        { type: 'tool_use', id: 't', name: 'lookup', input: { q: 'PSEUDO_B', n: 2 } },
      ],
      usage: { input_tokens: 4 },
    }
    expect(anthropicWalker.response(body, ctx)).toEqual({
      id: 'msg_1',
      type: 'message',
      content: [
        { type: 'thinking', thinking: 'Lena thinks', signature: 'SIG3' },
        { type: 'redacted_thinking', data: 'ENC' },
        { type: 'text', text: 'Hi Lena' },
        { type: 'tool_use', id: 't', name: 'lookup', input: { q: 'say "hi"', n: 2 } },
      ],
      usage: { input_tokens: 4 },
    })
    expect(ctx.signatures.get('anthropic:SIG3')).toBe('PSEUDO_A thinks')
  })
})

describe('anthropic stream (SSE)', () => {
  test('text restores to the same output at every two-way split point', () => {
    const whole = run(context(), [TEXT_STREAM])
    expect(streamedText(whole)).toBe('Hallo Lena, bye')
    for (let i = 0; i <= TEXT_STREAM.length; i++) {
      expect(run(context(), [TEXT_STREAM.slice(0, i), TEXT_STREAM.slice(i)])).toBe(whole)
    }
  })

  test('byte-by-byte chunking gives the same output', () => {
    const whole = run(context(), [TEXT_STREAM])
    expect(run(context(), TEXT_STREAM.split(''))).toBe(whole)
  })

  test('events without text are re-emitted byte for byte', () => {
    const whole = run(context(), [TEXT_STREAM])
    expect(whole).toContain('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","content":[]}}\n\n')
    expect(whole).toContain('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })

  test('streamed tool arguments restore an original that contains quotes, as valid JSON', () => {
    const stream = sse([
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name: 'lookup', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"PSEU' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'DO_B","n":2}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ])
    const out = run(context(), stream.split(''))
    const json = payloads(out)
      .map((p) => (p.delta as { partial_json?: string } | undefined)?.partial_json ?? '')
      .join('')
    expect(JSON.parse(json)).toEqual({ q: 'say "hi"', n: 2 })
    expect(run(context(), [stream])).toBe(out)
  })

  test('a thinking block caches its raw text under the signature from the signature_delta', () => {
    const ctx = context()
    const stream = sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PSEUDO_A ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinks' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG7' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ])
    const out = run(ctx, [stream])
    expect(payloads(out).flatMap((p) => {
      const delta = p.delta as { thinking?: string } | undefined
      return delta?.thinking === undefined ? [] : [delta.thinking]
    }).join('')).toBe('Lena thinks')
    expect(ctx.signatures.get('anthropic:SIG7')).toBe('PSEUDO_A thinks')
  })

  test('a stream that ends with an open text block flushes its held tail', () => {
    const stream = sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'end PSEU' } }],
    ])
    expect(streamedText(run(context(), [stream]))).toBe('end PSEU')
  })
})
