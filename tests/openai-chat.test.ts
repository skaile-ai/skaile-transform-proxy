import { describe, expect, test } from 'bun:test'
import type { TextLeaf, Transform } from '../src/contract.ts'
import { openaiChatWalker } from '../src/wire/openai-chat.ts'
import { UnsupportedContentError, type WireContext } from '../src/wire/types.ts'

// Fake transform: reversible pairs; the second original holds JSON escape characters.
const PAIRS: readonly { orig: string; ph: string }[] = [
  { orig: 'Alice', ph: 'PSEUDO_A' },
  { orig: 'say "hi" \\o/', ph: 'PSEUDO_B' },
]

const anonymize = (text: string): string => PAIRS.reduce((acc, p) => acc.split(p.orig).join(p.ph), text)
const restore = (text: string): string => PAIRS.reduce((acc, p) => acc.split(p.ph).join(p.orig), text)

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
    push(chunk) {
      const text = held + chunk
      const keep = heldSuffix(text)
      held = text.slice(text.length - keep)
      return restore(text.slice(0, text.length - keep))
    },
    flush() {
      const out = restore(held)
      held = ''
      return out
    },
  }
}

function context(calls: { text: string; leaf: TextLeaf }[] = [], instruction: string | null = 'INSTR'): WireContext {
  const transform: Transform = {
    instruction: instruction ?? undefined,
    async outbound(text, leaf) {
      calls.push({ text, leaf })
      return anonymize(text)
    },
    inbound: restore,
    inboundStream: streamRestorer,
  }
  return { transform, signatures: new Map() }
}

const sse = (payloads: readonly unknown[]): string =>
  payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n'

function run(ctx: WireContext, chunks: readonly string[]): string {
  const t = openaiChatWalker.stream(ctx)
  let out = ''
  for (const chunk of chunks) out += t.push(chunk)
  return out + t.flush()
}

function parse(out: string): unknown[] {
  return out.split('\n\n').filter((b) => b.startsWith('data: ') && !b.includes('[DONE]')).map((b) => JSON.parse(b.slice(6)))
}

/** Concatenated delta field across all chunks of choice 0. */
function collect(out: string, pick: (delta: Record<string, any>) => string | undefined): string {
  return parse(out).map((p: any) => pick(p.choices?.[0]?.delta ?? {}) ?? '').join('')
}

const env = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm' }
const chunk = (delta: unknown, finish: string | null = null) => ({ ...env, choices: [{ index: 0, delta, finish_reason: finish }] })

describe('openaiChatWalker.request', () => {
  const body = {
    model: 'm',
    tools: [{ type: 'function', function: { name: 'lookup', description: 'Alice', parameters: {} } }],
    messages: [
      { role: 'system', content: 'sys Alice' },
      { role: 'developer', content: [{ type: 'text', text: 'dev Alice' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi Alice' }, { type: 'mystery', x: 'Alice' }] },
      {
        role: 'assistant',
        content: 'ok Alice',
        reasoning_content: 'think Alice',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"q":"Alice","n":[1,"Alice"]}' } }],
      },
      { role: 'tool', tool_call_id: 't1', content: 'found Alice' },
      { role: 'assistant', reasoning: 'r Alice', tool_calls: [{ id: 't2', type: 'function', function: { name: 'raw', arguments: 'not json Alice' } }] },
    ],
  }

  test('rewrites every leaf with its kind, tools untouched, instruction first', async () => {
    const calls: { text: string; leaf: TextLeaf }[] = []
    const snapshot = JSON.stringify(body)
    const out: any = await openaiChatWalker.request(body, context(calls))
    expect(JSON.stringify(body)).toBe(snapshot)
    expect(calls).toEqual([
      { text: 'sys Alice', leaf: { kind: 'system' } },
      { text: 'dev Alice', leaf: { kind: 'system' } },
      { text: 'hi Alice', leaf: { kind: 'user' } },
      { text: 'think Alice', leaf: { kind: 'thinking' } },
      { text: 'ok Alice', leaf: { kind: 'assistant' } },
      { text: 'Alice', leaf: { kind: 'toolCall', toolName: 'lookup' } },
      { text: 'Alice', leaf: { kind: 'toolCall', toolName: 'lookup' } },
      { text: 'found Alice', leaf: { kind: 'toolResult', toolName: 'lookup' } },
      { text: 'r Alice', leaf: { kind: 'thinking' } },
      { text: 'not json Alice', leaf: { kind: 'toolCall', toolName: 'raw' } },
    ])
    expect(out.tools).toEqual(body.tools)
    expect(out.messages[0]).toEqual({ role: 'system', content: 'INSTR' })
    expect(out.messages[1].content).toBe('sys PSEUDO_A')
    expect(out.messages[3].content[1]).toEqual({ type: 'mystery', x: 'Alice' })
    expect(out.messages[4].tool_calls[0].function.arguments).toBe('{"q":"PSEUDO_A","n":[1,"PSEUDO_A"]}')
    expect(out.messages[6].tool_calls[0].function.arguments).toBe('not json PSEUDO_A')
    expect('content' in out.messages[6]).toBe(false)
  })

  test('no instruction adds no message', async () => {
    const out: any = await openaiChatWalker.request({ messages: [{ role: 'user', content: 'x' }] }, context([], null))
    expect(out.messages).toEqual([{ role: 'user', content: 'x' }])
  })

  for (const type of ['image_url', 'input_audio', 'file']) {
    test(`refuses ${type} parts`, async () => {
      const req = { messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type, [type]: {} }] }] }
      expect(openaiChatWalker.request(req, context())).rejects.toBeInstanceOf(UnsupportedContentError)
    })
  }
})

describe('openaiChatWalker.response', () => {
  test('restores content, reasoning and tool arguments', () => {
    const out: any = openaiChatWalker.response({
      id: 'x',
      choices: [{ index: 0, message: {
        role: 'assistant', content: 'hi PSEUDO_A', reasoning_content: 'PSEUDO_A thinks',
        tool_calls: [{ id: 't', function: { name: 'f', arguments: '{"a":"PSEUDO_B"}' } }, { id: 'u', function: { name: 'g', arguments: 'PSEUDO_A' } }],
      }, finish_reason: 'stop' }],
    }, context())
    const m = out.choices[0].message
    expect(m.content).toBe('hi Alice')
    expect(m.reasoning_content).toBe('Alice thinks')
    expect(JSON.parse(m.tool_calls[0].function.arguments)).toEqual({ a: 'say "hi" \\o/' })
    expect(m.tool_calls[1].function.arguments).toBe('Alice')
  })
})

describe('openaiChatWalker.stream', () => {
  const input = sse([
    chunk({ role: 'assistant', content: '' }),
    chunk({ reasoning_content: 'hm PSEU' }),
    chunk({ reasoning_content: 'DO_A.' }),
    chunk({ content: 'Hello PSE' }),
    chunk({ content: 'UDO_A and PSEUDO_' }),
    chunk({ tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'f', arguments: '{"a":"PSEU' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'DO_B","b":"PSEUDO_' } }] }),
    chunk({}, 'stop'),
  ])

  const check = (out: string): void => {
    expect(collect(out, (d) => d.content)).toBe('Hello Alice and PSEUDO_')
    expect(collect(out, (d) => d.reasoning_content)).toBe('hm Alice.')
    const args = collect(out, (d) => d.tool_calls?.[0]?.function?.arguments)
    expect(args).toBe('{"a":"say \\"hi\\" \\\\o/","b":"PSEUDO_')
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true)
  }

  test('restores and flushes tails before the finish_reason chunk', () => {
    const out = run(context(), [input])
    check(out)
    const events = parse(out) as any[]
    const finishAt = events.findIndex((e) => e.choices[0].finish_reason === 'stop')
    expect(finishAt).toBe(events.length - 1)
    const tail = events[finishAt - 1]
    expect(tail).toMatchObject({ ...env, choices: [{ index: 0, finish_reason: null }] })
    expect(tail.choices[0].delta).toEqual({ content: 'PSEUDO_', tool_calls: [{ index: 0, function: { arguments: 'PSEUDO_' } }] })
  })

  test('identical at every 2-way split and byte-by-byte', () => {
    const whole = run(context(), [input])
    for (let i = 1; i < input.length; i++) expect(run(context(), [input.slice(0, i), input.slice(i)])).toBe(whole)
    expect(run(context(), [...input])).toBe(whole)
  })

  test('streamed tool args restore into valid JSON', () => {
    const out = run(context(), [sse([
      chunk({ tool_calls: [{ index: 0, function: { name: 'f', arguments: '{"a":"x PSEUDO' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '_B y"}' } }] }),
      chunk({}, 'tool_calls'),
    ])])
    expect(JSON.parse(collect(out, (d) => d.tool_calls?.[0]?.function?.arguments))).toEqual({ a: 'x say "hi" \\o/ y' })
  })

  test('unrelated events byte-identical; open streams flushed before [DONE]', () => {
    const raw = 'data: {"weird":true}\n\n: comment\n\n'
    const out = run(context(), [raw + sse([chunk({ content: 'PSEUDO_' })])])
    expect(out.startsWith(raw)).toBe(true)
    expect(collect(out, (d) => d.content)).toBe('PSEUDO_')
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true)
  })
})
