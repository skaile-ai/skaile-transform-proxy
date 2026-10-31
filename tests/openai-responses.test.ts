import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { TextLeaf, Transform } from '../src/contract.ts'
import { openaiResponsesWalker } from '../src/wire/openai-responses.ts'
import { UnsupportedContentError, type WireContext } from '../src/wire/types.ts'

// Two reversible pairs; the second original holds `"`, the third `\`, to exercise JSON escaping.
const PAIRS: readonly { orig: string; ph: string }[] = [
  { orig: 'Lena', ph: 'PSEUDO_A' },
  { orig: 'say "hi"', ph: 'PSEUDO_B' },
  { orig: 'C:\\Users', ph: 'PSEUDO_C' },
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

function fakeTransform(calls: { text: string; leaf: TextLeaf }[], instruction: string | null = 'INSTR'): Transform {
  return {
    ...(instruction === null ? {} : { instruction }),
    async outbound(text, leaf) {
      calls.push({ text, leaf })
      return anonymize(text)
    },
    inbound: restore,
    inboundStream: streamRestorer,
  }
}

function context(calls: { text: string; leaf: TextLeaf }[] = [], instruction: string | null = 'INSTR'): WireContext {
  return { transform: fakeTransform(calls, instruction), signatures: new Map() }
}

type Obj = Record<string, unknown>

const fixture = (): Obj =>
  JSON.parse(readFileSync(new URL('./fixtures/openai-responses/request.json', import.meta.url), 'utf8')) as Obj

describe('openai responses request', () => {
  test('rewrites every leaf with kind and tool name, keeps tools, metadata and unknown items', async () => {
    const calls: { text: string; leaf: TextLeaf }[] = []
    const body = fixture()
    const before = JSON.stringify(body)
    const out = (await openaiResponsesWalker.request(body, context(calls))) as Obj
    expect(JSON.stringify(body)).toBe(before)

    expect(calls).toEqual([
      { text: 'You help Lena.', leaf: { kind: 'system' } },
      { text: 'Developer note for Lena', leaf: { kind: 'system' } },
      { text: 'System Lena', leaf: { kind: 'system' } },
      { text: 'Hi, I am Lena', leaf: { kind: 'user' } },
      { text: 'Thinking about Lena', leaf: { kind: 'thinking' } },
      { text: 'Hello Lena', leaf: { kind: 'assistant' } },
      { text: 'Lena', leaf: { kind: 'toolCall', toolName: 'lookup' } },
      { text: 'say "hi"', leaf: { kind: 'toolCall', toolName: 'lookup' } },
      { text: 'Lena found', leaf: { kind: 'toolResult', toolName: 'lookup' } },
      { text: 'Lena raw', leaf: { kind: 'toolCall', toolName: 'notes' } },
      { text: 'note on Lena', leaf: { kind: 'toolResult', toolName: 'notes' } },
    ])

    expect(out.instructions).toBe('INSTR\n\nYou help PSEUDO_A.')
    expect(out.tools).toEqual(body.tools)
    expect(out.metadata).toEqual(body.metadata)
    const input = out.input as Obj[]
    expect(input[0]).toEqual({ role: 'developer', content: 'Developer note for PSEUDO_A' })
    expect((input[2]!.content as Obj[])[1]).toEqual({ type: 'custom_part', text: 'Lena' })
    expect(input[3]!.encrypted_content).toBe('ENC(Lena)')
    expect(JSON.parse(input[5]!.arguments as string)).toEqual({ name: 'PSEUDO_A', tags: ['PSEUDO_B'], n: 2 })
    expect(input[7]!.arguments).toBe('PSEUDO_A raw')
    expect(input[9]).toEqual((body.input as Obj[])[9]!)
  })

  test('string input is a user leaf; instruction is set when instructions are absent', async () => {
    const calls: { text: string; leaf: TextLeaf }[] = []
    const out = (await openaiResponsesWalker.request({ model: 'm', input: 'I am Lena' }, context(calls))) as Obj
    expect(calls).toEqual([{ text: 'I am Lena', leaf: { kind: 'user' } }])
    expect(out).toEqual({ model: 'm', input: 'I am PSEUDO_A', instructions: 'INSTR' })
  })

  test('without an instruction, instructions stay absent', async () => {
    const out = (await openaiResponsesWalker.request({ input: 'x' }, context([], null))) as Obj
    expect('instructions' in out).toBe(false)
  })

  test('refuses attachments', async () => {
    for (const type of ['input_image', 'input_file', 'input_audio']) {
      const body = { input: [{ role: 'user', content: [{ type: 'input_text', text: 'a' }, { type }] }] }
      await expect(openaiResponsesWalker.request(body, context())).rejects.toBeInstanceOf(UnsupportedContentError)
    }
    const output = { input: [{ type: 'function_call_output', call_id: 'c', output: [{ type: 'input_image', image_url: 'x' }] }] }
    await expect(openaiResponsesWalker.request(output, context())).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  test.each([
    ['a string root', 'Lena'],
    ['an array root', [{ input: 'Lena' }]],
    ['numeric instructions', { instructions: 42, input: 'x' }],
    ['object instructions', { instructions: { text: 'Lena' }, input: 'x' }],
    ['object input', { input: { role: 'user', content: 'Lena' } }],
    ['numeric input', { input: 7 }],
    ['a string input item', { input: ['Lena'] }],
    ['an unknown message role', { input: [{ type: 'message', role: 'narrator', content: 'Lena' }] }],
    ['a numeric role', { input: [{ role: 5, content: 'Lena' }] }],
    ['object message content', { input: [{ role: 'user', content: { text: 'Lena' } }] }],
    ['a string in a content array', { input: [{ role: 'user', content: ['Lena'] }] }],
    ['a non-string input_text part', { input: [{ role: 'user', content: [{ type: 'input_text', text: { v: 'Lena' } }] }] }],
    ['object function_call arguments', { input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: { q: 'Lena' } }] }],
    ['object function_call_output output', { input: [{ type: 'function_call_output', call_id: 'c', output: { text: 'Lena' } }] }],
    ['a string reasoning summary', { input: [{ type: 'reasoning', id: 'rs', summary: 'Lena' }] }],
    ['a non-string summary part', { input: [{ type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: ['Lena'] }] }] }],
  ])('refuses %s with unsupported_content', async (_name, body) => {
    await expect(openaiResponsesWalker.request(body, context())).rejects.toBeInstanceOf(UnsupportedContentError)
  })

  test('reasoning cache hit swaps the raw summary back byte for byte without outbound', async () => {
    const ctx = context()
    openaiResponsesWalker.response({
      output: [{ type: 'reasoning', id: 'rs_9', summary: [{ type: 'summary_text', text: 'raw PSEUDO_A  é\n' }] }],
    }, ctx)
    const calls: { text: string; leaf: TextLeaf }[] = []
    const next: WireContext = { transform: fakeTransform(calls), signatures: ctx.signatures }
    const item = { type: 'reasoning', id: 'rs_9', summary: [{ type: 'summary_text', text: 'raw Lena  é\n' }], encrypted_content: 'E' }
    const out = (await openaiResponsesWalker.request({ input: [item] }, next)) as Obj
    expect(calls.filter((c) => c.leaf.kind === 'thinking')).toEqual([])
    expect((out.input as Obj[])[0]).toEqual({ ...item, summary: [{ type: 'summary_text', text: 'raw PSEUDO_A  é\n' }] })
  })

  test('reasoning cache miss rewrites the summary and keeps encrypted_content', async () => {
    const calls: { text: string; leaf: TextLeaf }[] = []
    const item = { type: 'reasoning', id: 'rs_x', summary: [{ type: 'summary_text', text: 'Lena' }], encrypted_content: 'E' }
    const out = (await openaiResponsesWalker.request({ input: [item] }, context(calls))) as Obj
    expect(calls).toEqual([{ text: 'Lena', leaf: { kind: 'thinking' } }])
    expect((out.input as Obj[])[0]).toEqual({ ...item, summary: [{ type: 'summary_text', text: 'PSEUDO_A' }] })
  })
})

describe('openai responses JSON response', () => {
  test('restores text, reasoning, tool args and output_text; stores the raw summary', () => {
    const ctx = context()
    const args = JSON.stringify({ q: 'PSEUDO_B', path: 'PSEUDO_C' })
    const out = openaiResponsesWalker.response({
      id: 'resp_1',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'about PSEUDO_A' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi PSEUDO_A', annotations: [] }] },
        { type: 'function_call', call_id: 'c', name: 'f', arguments: args },
      ],
      output_text: 'Hi PSEUDO_A',
    }, ctx) as Obj
    const output = out.output as Obj[]
    expect((output[0]!.summary as Obj[])[0]!.text).toBe('about Lena')
    expect((output[1]!.content as Obj[])[0]).toEqual({ type: 'output_text', text: 'Hi Lena', annotations: [] })
    expect(JSON.parse(output[2]!.arguments as string)).toEqual({ q: 'say "hi"', path: 'C:\\Users' })
    expect(out.output_text).toBe('Hi Lena')
    expect(ctx.signatures.get('responses:rs_1')).toBe(JSON.stringify(['about PSEUDO_A']))
  })
})

const sse = (events: readonly Obj[]): string =>
  events.map((data) => `event: ${data.type as string}\ndata: ${JSON.stringify(data)}\n\n`).join('')

function run(ctx: WireContext, chunks: readonly string[]): string {
  const transformer = openaiResponsesWalker.stream(ctx)
  let out = ''
  for (const chunk of chunks) out += transformer.push(chunk)
  return out + transformer.flush()
}

function payloads(out: string): Obj[] {
  return out.split('\n\n').filter((b) => b.trim() !== '').map((block) => {
    const line = block.split('\n').find((l) => l.startsWith('data: '))
    return JSON.parse(line?.slice(6) ?? 'null') as Obj
  })
}

const deltas = (out: string, type: string): string =>
  payloads(out).filter((p) => p.type === type).map((p) => p.delta as string).join('')

const ARGS = JSON.stringify({ q: 'PSEUDO_B', path: 'PSEUDO_C' })

const STREAM = sse([
  { type: 'response.created', sequence_number: 0, response: { id: 'r', output: [] } },
  { type: 'response.reasoning_summary_text.delta', sequence_number: 1, item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'about PSEU' },
  { type: 'response.reasoning_summary_text.delta', sequence_number: 2, item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'DO_A' },
  { type: 'response.reasoning_summary_text.done', sequence_number: 3, item_id: 'rs_1', output_index: 0, summary_index: 0, text: 'about PSEUDO_A' },
  { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'about PSEUDO_A' }] } },
  { type: 'response.output_text.delta', sequence_number: 5, item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Hi PSEUDO' },
  { type: 'response.output_text.delta', sequence_number: 6, item_id: 'msg_1', output_index: 1, content_index: 0, delta: '_A! PSEUDO_' },
  { type: 'response.output_text.done', sequence_number: 7, item_id: 'msg_1', output_index: 1, content_index: 0, text: 'Hi PSEUDO_A! PSEUDO_' },
  { type: 'response.content_part.done', sequence_number: 8, item_id: 'msg_1', output_index: 1, content_index: 0, part: { type: 'output_text', text: 'Hi PSEUDO_A! PSEUDO_' } },
  { type: 'response.function_call_arguments.delta', sequence_number: 9, item_id: 'fc_1', output_index: 2, delta: ARGS.slice(0, 12) },
  { type: 'response.function_call_arguments.delta', sequence_number: 10, item_id: 'fc_1', output_index: 2, delta: ARGS.slice(12) },
  { type: 'response.function_call_arguments.done', sequence_number: 11, item_id: 'fc_1', output_index: 2, arguments: ARGS },
  { type: 'response.completed', sequence_number: 12, response: { id: 'r', output: [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'about PSEUDO_A' }] },
    { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Hi PSEUDO_A! PSEUDO_' }] },
    { type: 'function_call', id: 'fc_1', arguments: ARGS },
  ] } },
])

describe('openai responses stream (SSE)', () => {
  test('restores deltas, emits tails before .done, restores done/completed texts and stores the cache', () => {
    const ctx = context()
    const out = run(ctx, [STREAM])
    expect(deltas(out, 'response.output_text.delta')).toBe('Hi Lena! PSEUDO_')
    expect(deltas(out, 'response.reasoning_summary_text.delta')).toBe('about Lena')
    const args = deltas(out, 'response.function_call_arguments.delta')
    expect(JSON.parse(args)).toEqual({ q: 'say "hi"', path: 'C:\\Users' })

    const events = payloads(out)
    const textDone = events.findIndex((p) => p.type === 'response.output_text.done')
    expect(events[textDone - 1]).toMatchObject({ type: 'response.output_text.delta', delta: 'PSEUDO_', sequence_number: 7, item_id: 'msg_1', content_index: 0 })
    expect(events[textDone]!.text).toBe('Hi Lena! PSEUDO_')
    expect(events.find((p) => p.type === 'response.reasoning_summary_text.done')!.text).toBe('about Lena')
    expect((events.find((p) => p.type === 'response.content_part.done')!.part as Obj).text).toBe('Hi Lena! PSEUDO_')
    expect(JSON.parse(events.find((p) => p.type === 'response.function_call_arguments.done')!.arguments as string))
      .toEqual({ q: 'say "hi"', path: 'C:\\Users' })
    const completed = (events.find((p) => p.type === 'response.completed')!.response as Obj).output as Obj[]
    expect((completed[0]!.summary as Obj[])[0]!.text).toBe('about Lena')
    expect((completed[1]!.content as Obj[])[0]!.text).toBe('Hi Lena! PSEUDO_')
    expect(JSON.parse(completed[2]!.arguments as string)).toEqual({ q: 'say "hi"', path: 'C:\\Users' })
    expect(ctx.signatures.get('responses:rs_1')).toBe(JSON.stringify(['about PSEUDO_A']))
  })

  test('identical output at every two-way split and byte by byte', () => {
    const whole = run(context(), [STREAM])
    for (let i = 0; i <= STREAM.length; i++) {
      expect(run(context(), [STREAM.slice(0, i), STREAM.slice(i)])).toBe(whole)
    }
    expect(run(context(), STREAM.split(''))).toBe(whole)
  })

  test('unrelated events stay byte-identical', () => {
    const raw = 'event: response.in_progress\ndata: {"type":"response.in_progress",  "sequence_number":1}\n\n: comment\n\n'
    expect(run(context(), [raw])).toBe(raw)
  })
})
