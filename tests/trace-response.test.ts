import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createTransformProxy,
  SESSION_HEADER,
  UPSTREAM_HEADER,
  type Logger,
  type TraceEvent,
  type TraceSink,
  type TransformProxy,
} from '../src/index.ts'
import { scriptedModule, splitBytes, startFakeUpstream, type FakeUpstream } from './support.ts'

let upstream: FakeUpstream
let proxies: TransformProxy[] = []

beforeEach(async () => {
  upstream = await startFakeUpstream()
})

afterEach(async () => {
  for (const proxy of proxies) await proxy.close()
  proxies = []
  await upstream.close()
})

async function start(trace: TraceSink | undefined): Promise<{ proxy: TransformProxy; errors: string[] }> {
  const { module } = scriptedModule()
  const errors: string[] = []
  const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: (msg) => errors.push(msg) }
  const proxy = await createTransformProxy({
    baseDir: process.cwd(),
    transforms: { scripted: { module } },
    pipelines: { anon: ['scripted'] },
    defaultPipeline: 'anon',
    log,
    ...(trace === undefined ? {} : { trace }),
  })
  proxies.push(proxy)
  return { proxy, errors }
}

async function startCapturing(): Promise<{ proxy: TransformProxy; events: TraceEvent[]; errors: string[] }> {
  const events: TraceEvent[] = []
  const { proxy, errors } = await start({ record: (event) => events.push(event) })
  return { proxy, events, errors }
}

function send(base: string, path: string, body: unknown, target = upstream.url): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [UPSTREAM_HEADER]: target, [SESSION_HEADER]: 's1' },
    body: JSON.stringify(body),
  })
}

const ANTHROPIC = { model: 'claude-test', max_tokens: 64, messages: [{ role: 'user', content: 'Alice asks' }] }
const CHAT = { model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'Alice asks' }] }
const RESPONSES = { model: 'gpt-test', stream: true, input: [{ role: 'user', content: 'Alice asks' }] }

/** The single response or error line of a one-request run, after checking it is the only one and matches the request. */
function reply(events: readonly TraceEvent[]): TraceEvent {
  const requests = events.filter((event) => event.phase === 'request')
  const others = events.filter((event) => event.phase !== 'request')
  expect(requests).toHaveLength(1)
  expect(others).toHaveLength(1)
  const [request] = requests
  const [line] = others
  expect(line!.requestId).toBe(request!.requestId)
  expect(line).toMatchObject({
    sessionId: request!.sessionId,
    pipeline: request!.pipeline,
    route: request!.route,
    upstream: request!.upstream,
    leaks: [],
  })
  expect(typeof line!.durationMs).toBe('number')
  expect(line!.durationMs!).toBeGreaterThanOrEqual(0)
  expect(Number.isNaN(Date.parse(line!.at))).toBe(false)
  return line!
}

function sse(events: readonly { event?: string; data: unknown }[]): string {
  return events
    .map(({ event, data }) => `${event === undefined ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    .join('')
}

/** The fields of an SSE data payload that carry streamed text in these tests' fixtures. */
interface TextEvent {
  readonly type?: string
  readonly delta?: string | { readonly text?: string }
}

/** Concatenated text deltas of an SSE body (Anthropic `delta.text`, OpenAI responses `delta`), as the client reads it. */
function streamedText(body: string): string {
  let out = ''
  for (const block of body.split('\n\n')) {
    const data = block.split('\n').find((line) => line.startsWith('data: '))
    if (data === undefined) continue
    const event: TextEvent = JSON.parse(data.slice('data: '.length))
    if (event.type === 'content_block_delta' && typeof event.delta === 'object') out += event.delta.text ?? ''
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') out += event.delta
  }
  return out
}

const ANTHROPIC_SSE = sse([
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-test', stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
    },
  },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello P' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1, Müller ist da' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
])

describe('response trace', () => {
  test('Anthropic JSON: the line holds the reply before restore, the client gets it restored', async () => {
    const { proxy, events } = await startCapturing()
    upstream.reply = {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hi P1' }] }),
    }
    const res = await send(proxy.url, '/v1/messages', ANTHROPIC)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ content: [{ type: 'text', text: 'Hi Alice' }] })

    const line = reply(events)
    expect(line.phase).toBe('response')
    expect(line.status).toBe(200)
    expect(line.content).toEqual({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hi P1' }] })
  })

  test('Anthropic SSE: the line holds the assembled message with placeholders, the client stream is unchanged', async () => {
    upstream.reply = { headers: { 'content-type': 'text/event-stream' }, body: splitBytes(Buffer.from(ANTHROPIC_SSE, 'utf8'), 5) }
    const plain = await start(undefined)
    const expected = await (await send(plain.proxy.url, '/v1/messages', ANTHROPIC)).text()

    const { proxy, events, errors } = await startCapturing()
    const res = await send(proxy.url, '/v1/messages', ANTHROPIC)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toBe(expected)
    expect(streamedText(body)).toBe('Hello Alice, Müller ist da')
    expect(body).not.toContain('P1')

    const line = reply(events)
    expect(line.phase).toBe('response')
    expect(line.status).toBe(200)
    expect(line.content).toMatchObject({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello P1, Müller ist da' }],
      stop_reason: 'end_turn',
    })
    expect(errors).toEqual([])
  })

  test('an SSE stream that ends before a complete reply still gives one response line, without content', async () => {
    const { proxy, events } = await startCapturing()
    upstream.reply = {
      headers: { 'content-type': 'text/event-stream' },
      body: sse([{ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'P1' } } }]),
    }
    expect((await send(proxy.url, '/v1/messages', ANTHROPIC)).status).toBe(200)
    const line = reply(events)
    expect(line.phase).toBe('response')
    expect(line.status).toBe(200)
    expect(line.content).toBeUndefined()
  })

  test('OpenAI chat SSE: one response line with the assembled completion before restore', async () => {
    const { proxy, events } = await startCapturing()
    const env = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-test' }
    upstream.reply = {
      headers: { 'content-type': 'text/event-stream' },
      body: sse([
        { data: { ...env, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi P' }, finish_reason: null }] } },
        { data: { ...env, choices: [{ index: 0, delta: { content: '1!' }, finish_reason: null }] } },
        { data: { ...env, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
        { data: '[DONE]' },
      ]),
    }
    const res = await send(proxy.url, '/v1/chat/completions', CHAT)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('P1')

    const line = reply(events)
    expect(line).toMatchObject({ phase: 'response', status: 200, route: 'openai.chat', model: 'gpt-test' })
    expect(line.content).toMatchObject({
      id: 'c1',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi P1!' }, finish_reason: 'stop' }],
    })
  })

  test('OpenAI responses SSE: one response line with the completed response before restore', async () => {
    const { proxy, events } = await startCapturing()
    const completed = { id: 'r1', status: 'completed', output: [{ type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Hi P1!' }] }] }
    upstream.reply = {
      headers: { 'content-type': 'text/event-stream' },
      body: sse([
        { event: 'response.created', data: { type: 'response.created', sequence_number: 0, response: { id: 'r1', output: [] } } },
        {
          event: 'response.output_text.delta',
          data: { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hi P1!' },
        },
        { event: 'response.completed', data: { type: 'response.completed', sequence_number: 2, response: completed } },
      ]),
    }
    const res = await send(proxy.url, '/v1/responses', RESPONSES)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(streamedText(body)).toBe('Hi Alice!')
    expect(body).not.toContain('P1')

    const line = reply(events)
    expect(line).toMatchObject({ phase: 'response', status: 200, route: 'openai.responses' })
    expect(line.content).toEqual(completed)
  })

  test('count_tokens: the JSON reply is traced as parsed, the client gets the bytes untouched', async () => {
    const { proxy, events } = await startCapturing()
    const raw = '{ "input_tokens": 5, "echo": "P1" }'
    upstream.reply = { headers: { 'content-type': 'application/json' }, body: raw }
    const res = await send(proxy.url, '/v1/messages/count_tokens', ANTHROPIC)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(raw)

    const line = reply(events)
    expect(line).toMatchObject({ phase: 'response', status: 200, route: 'anthropic.count_tokens' })
    expect(line.content).toEqual({ input_tokens: 5, echo: 'P1' })
  })

  test('a 2xx JSON reply that does not parse gives an error line with status 502; the client sees what it saw before', async () => {
    upstream.reply = { headers: { 'content-type': 'application/json' }, body: '{ not json' }
    const plain = await start(undefined)
    const before = await send(plain.proxy.url, '/v1/messages', ANTHROPIC)
    const expected = { status: before.status, body: await before.text() }

    const { proxy, events } = await startCapturing()
    const res = await send(proxy.url, '/v1/messages', ANTHROPIC)
    expect({ status: res.status, body: await res.text() }).toEqual(expected)

    const line = reply(events)
    expect(line.phase).toBe('error')
    expect(line.status).toBe(502)
    expect(typeof line.content).toBe('string')
    expect(line.content as string).not.toBe('')
  })

  test('any other 2xx body gives a response line without content', async () => {
    const { proxy, events } = await startCapturing()
    upstream.reply = { headers: { 'content-type': 'text/plain' }, body: 'plain P1' }
    const res = await send(proxy.url, '/v1/messages', ANTHROPIC)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('plain P1')

    const line = reply(events)
    expect(line).toMatchObject({ phase: 'response', status: 200 })
    expect(line.content).toBeUndefined()
  })

  test('a 400 from the upstream gives one error line with the body text; the client gets the same status and body', async () => {
    const { proxy, events } = await startCapturing()
    const raw = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad P1' } })
    upstream.reply = { status: 400, headers: { 'content-type': 'application/json' }, body: raw }
    const res = await send(proxy.url, '/v1/messages', ANTHROPIC)
    expect(res.status).toBe(400)
    expect(await res.text()).toBe(raw)

    const line = reply(events)
    expect(line).toMatchObject({ phase: 'error', status: 400, content: raw })
  })

  test('an upstream error body is cut to 4096 characters in the line, never for the client', async () => {
    const { proxy, events } = await startCapturing()
    const raw = 'x'.repeat(5000)
    upstream.reply = { status: 500, headers: { 'content-type': 'text/plain' }, body: raw }
    const res = await send(proxy.url, '/v1/messages', ANTHROPIC)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe(raw)

    const line = reply(events)
    expect(line).toMatchObject({ phase: 'error', status: 500, content: 'x'.repeat(4096) })
  })

  test('an unreachable upstream gives an error line with status 502 and the fetch error', async () => {
    const gone = await startFakeUpstream()
    await gone.close()
    const { proxy, events } = await startCapturing()
    const res = await send(proxy.url, '/v1/messages', ANTHROPIC, gone.url)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('upstream_unreachable')

    const line = reply(events)
    expect(line).toMatchObject({ phase: 'error', status: 502, content: body.error.message })
  })

  test('a throwing sink on the response side is logged and the client reply is unchanged', async () => {
    const { proxy, errors } = await start({
      record: (event) => {
        if (event.phase !== 'request') throw new Error('disk full')
      },
    })
    upstream.reply = { headers: { 'content-type': 'text/event-stream' }, body: ANTHROPIC_SSE }
    const res = await send(proxy.url, '/v1/messages', ANTHROPIC)
    expect(res.status).toBe(200)
    expect(streamedText(await res.text())).toBe('Hello Alice, Müller ist da')
    expect(errors).toEqual(['transform proxy: trace sink failed: disk full'])
  })
})
