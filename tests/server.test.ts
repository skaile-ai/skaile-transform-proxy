import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createTransformProxy,
  PIPELINE_HEADER,
  SESSION_HEADER,
  TOKEN_HEADER,
  UPSTREAM_HEADER,
  type TransformProxy,
} from '../src/index.ts'
import {
  scriptedModule,
  splitBytes,
  startFakeUpstream,
  type FakeUpstream,
  type ScriptedConfig,
  type ScriptedProbe,
} from './support.ts'

let upstream: FakeUpstream
let proxy: TransformProxy | undefined

beforeEach(async () => {
  upstream = await startFakeUpstream()
})

afterEach(async () => {
  await proxy?.close()
  proxy = undefined
  await upstream.close()
})

interface Setup {
  readonly scripted?: ScriptedConfig
  readonly token?: string
  readonly allowUpstreams?: readonly string[]
}

async function start(setup: Setup = {}): Promise<{ proxy: TransformProxy; probe: ScriptedProbe }> {
  const { module, probe } = scriptedModule(setup.scripted)
  const started = await createTransformProxy({
    baseDir: process.cwd(),
    transforms: { scripted: { module } },
    pipelines: { anon: ['scripted'], plain: [] },
    defaultPipeline: 'anon',
    token: setup.token,
    allowUpstreams: setup.allowUpstreams,
    port: 0,
  })
  proxy = started
  return { proxy: started, probe }
}

/** Headers a client sends to reach the proxy, addressing the fake upstream. */
function routed(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', [UPSTREAM_HEADER]: upstream.url, ...extra }
}

function messages(text: string): string {
  return JSON.stringify({
    model: 'claude-test',
    max_tokens: 64,
    system: 'You are helpful.',
    messages: [{ role: 'user', content: text }],
  })
}

function post(base: string, path: string, headers: Record<string, string>, body: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'POST', headers, body })
}

/** The request body the fake upstream received, typed for the fields these tests read. */
interface SentBody {
  readonly system?: unknown
  readonly messages: { readonly content: string }[]
}

function upstreamBody(index = 0): SentBody {
  const body: SentBody = JSON.parse(upstream.requests[index]!.body)
  return body
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The `error.type` of a proxy error envelope, or undefined when the body is not one. */
async function errorType(res: Response): Promise<unknown> {
  const body: unknown = await res.json()
  return isRecord(body) && isRecord(body.error) ? body.error.type : undefined
}

/** The text of every `text_delta` in an Anthropic SSE body. */
function streamedText(sse: string): string {
  let out = ''
  for (const block of sse.split('\n\n')) {
    const data = block.split('\n').find((line) => line.startsWith('data: '))
    if (data === undefined) continue
    const event: { type: string; delta?: { type: string; text?: string } } = JSON.parse(data.slice('data: '.length))
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') out += event.delta.text ?? ''
  }
  return out
}

describe('Anthropic round trip', () => {
  test('JSON: the request leaves out clear text, the reply is restored, the instruction is added', async () => {
    const { proxy } = await start({ scripted: { instruction: 'PSEUDONYMS-ARE-PEOPLE' } })
    upstream.reply = {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi P1, Alice is here' }],
      }),
    }
    const res = await post(proxy.url, '/v1/messages', routed(), messages('Alice asks'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ content: [{ text: 'Hi Alice, Alice is here' }] })

    const sent = upstreamBody()
    expect(sent.messages[0]!.content).toBe('P1 asks')
    expect(JSON.stringify(sent.system)).toContain('PSEUDONYMS-ARE-PEOPLE')
    expect(upstream.requests[0]!.body).not.toContain('Alice')
  })

  test('SSE: deltas split at every byte are restored, UTF-8 intact, no clear text leaves', async () => {
    const { proxy } = await start()
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello P"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1, Müller ist da"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    upstream.reply = {
      headers: { 'content-type': 'text/event-stream' },
      body: splitBytes(Buffer.from(sse, 'utf8'), 5),
    }
    const res = await post(proxy.url, '/v1/messages', routed(), messages('Alice asks'))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(streamedText(body)).toBe('Hello Alice, Müller ist da')
    expect(body).not.toContain('P1')
    expect(upstream.requests[0]!.body).not.toContain('Alice')
  })

  test('count_tokens: the request is rewritten, the response passes through untouched', async () => {
    const { proxy } = await start()
    upstream.reply = { body: JSON.stringify({ input_tokens: 5, echo: 'P1' }) }
    const res = await post(proxy.url, '/v1/messages/count_tokens', routed(), messages('Alice asks'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ echo: 'P1' })
    expect(upstreamBody().messages[0]!.content).toBe('P1 asks')
  })
})

describe('forwarding', () => {
  test('auth is relayed, the four proxy headers are stripped, accept-encoding is identity', async () => {
    const { proxy } = await start({ token: 'proxy-secret' })
    const res = await post(
      proxy.url,
      '/v1/messages',
      routed({
        [TOKEN_HEADER]: 'proxy-secret',
        [PIPELINE_HEADER]: 'plain',
        [SESSION_HEADER]: 's9',
        'x-api-key': 'sk-ant-test',
        authorization: 'Bearer oauth-abc',
        'anthropic-version': '2023-06-01',
      }),
      messages('Alice'),
    )
    expect(res.status).toBe(200)
    const sent = upstream.requests[0]!.headers
    expect(sent['x-api-key']).toBe('sk-ant-test')
    expect(sent.authorization).toBe('Bearer oauth-abc')
    expect(sent['anthropic-version']).toBe('2023-06-01')
    for (const name of [UPSTREAM_HEADER, SESSION_HEADER, PIPELINE_HEADER, TOKEN_HEADER]) {
      expect(sent[name]).toBeUndefined()
    }
    expect(sent['accept-encoding']).toBe('identity')
    // The plain pipeline has no stages: nothing is rewritten.
    expect(upstream.requests[0]!.body).toContain('Alice')
  })

  test('an upstream error is relayed verbatim: status, headers, body', async () => {
    const { proxy } = await start()
    const errorBody = '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'
    upstream.reply = { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' }, body: errorBody }
    const res = await post(proxy.url, '/v1/messages', routed(), messages('Alice'))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('7')
    expect(await res.text()).toBe(errorBody)
  })

  test('a GET to .../models passes through', async () => {
    const { proxy } = await start()
    const res = await fetch(`${proxy.url}/v1/models`, { headers: { [UPSTREAM_HEADER]: upstream.url } })
    expect(res.status).toBe(200)
    expect(upstream.requests[0]!.method).toBe('GET')
    expect(upstream.requests[0]!.url).toBe('/v1/models')
  })

  test('the upstream base path and query are kept', async () => {
    const { proxy } = await start()
    const res = await fetch(`${proxy.url}/v1/models?limit=2`, {
      headers: { [UPSTREAM_HEADER]: `${upstream.url}/base/` },
    })
    expect(res.status).toBe(200)
    expect(upstream.requests[0]!.url).toBe('/base/v1/models?limit=2')
  })
})

describe('refusals', () => {
  test('a request without the token gets 401, and nothing is sent upstream', async () => {
    const { proxy } = await start({ token: 'secret' })
    const missing = await post(proxy.url, '/v1/messages', routed(), messages('Alice'))
    expect(missing.status).toBe(401)
    const wrong = await post(proxy.url, '/v1/messages', routed({ [TOKEN_HEADER]: 'nope' }), messages('Alice'))
    expect(wrong.status).toBe(401)
    expect(upstream.requests).toHaveLength(0)
    const ok = await post(proxy.url, '/v1/messages', routed({ [TOKEN_HEADER]: 'secret' }), messages('Alice'))
    expect(ok.status).toBe(200)
  })

  test('OPTIONS is refused with 405, after the token check', async () => {
    const { proxy } = await start({ token: 'secret' })
    const noToken = await fetch(`${proxy.url}/v1/messages`, { method: 'OPTIONS', headers: routed() })
    expect(noToken.status).toBe(401)
    const withToken = await fetch(`${proxy.url}/v1/messages`, {
      method: 'OPTIONS',
      headers: routed({ [TOKEN_HEADER]: 'secret' }),
    })
    expect(withToken.status).toBe(405)
    expect(upstream.requests).toHaveLength(0)
  })

  test('a missing or non-http upstream is 400, a remote plain-http upstream is 403', async () => {
    const { proxy } = await start()
    const missing = await post(proxy.url, '/v1/messages', { 'content-type': 'application/json' }, messages('Alice'))
    expect(missing.status).toBe(400)
    expect(await errorType(missing)).toBe('missing_upstream')

    const ftp = await post(proxy.url, '/v1/messages', routed({ [UPSTREAM_HEADER]: 'ftp://example.com' }), messages('A'))
    expect(ftp.status).toBe(400)
    expect(await errorType(ftp)).toBe('invalid_upstream')

    const remote = await post(proxy.url, '/v1/messages', routed({ [UPSTREAM_HEADER]: 'http://example.com' }), messages('A'))
    expect(remote.status).toBe(403)
    expect(await errorType(remote)).toBe('upstream_not_allowed')
  })

  test('allowUpstreams restricts the origins that are reachable', async () => {
    const { proxy } = await start({ allowUpstreams: ['https://api.anthropic.com'] })
    const res = await post(proxy.url, '/v1/messages', routed(), messages('Alice'))
    expect(res.status).toBe(403)
    expect(upstream.requests).toHaveLength(0)
  })

  test('unknown routes and embeddings answer 404 unsupported_route; nothing is sent upstream', async () => {
    const { proxy } = await start()
    for (const path of ['/v1/chat/completions', '/v1/responses', '/v1/embeddings']) {
      const res = await post(proxy.url, path, routed(), JSON.stringify({ model: 'm', input: 'Alice' }))
      expect(res.status).toBe(404)
      expect(await errorType(res)).toBe('unsupported_route')
    }
    expect(upstream.requests).toHaveLength(0)
  })

  test('an unknown pipeline header is 400', async () => {
    const { proxy } = await start()
    const res = await post(proxy.url, '/v1/messages', routed({ [PIPELINE_HEADER]: 'nope' }), messages('Alice'))
    expect(res.status).toBe(400)
    expect(await errorType(res)).toBe('unknown_pipeline')
  })

  test('no pipeline header and no default pipeline is 400 no_pipeline', async () => {
    const { module } = scriptedModule()
    const noDefault = await createTransformProxy({
      baseDir: process.cwd(),
      transforms: { scripted: { module } },
      pipelines: { anon: ['scripted'] },
      port: 0,
    })
    proxy = noDefault
    const res = await post(noDefault.url, '/v1/messages', routed(), messages('Alice'))
    expect(res.status).toBe(400)
    expect(await errorType(res)).toBe('no_pipeline')
    expect(upstream.requests).toHaveLength(0)
  })

  test('an attachment is refused 400 unsupported_content and nothing is sent upstream', async () => {
    const { proxy } = await start()
    const image = JSON.stringify({
      model: 'm',
      max_tokens: 8,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }],
        },
      ],
    })
    const res = await post(proxy.url, '/v1/messages', routed(), image)
    expect(res.status).toBe(400)
    expect(await errorType(res)).toBe('unsupported_content')
    expect(upstream.requests).toHaveLength(0)
  })
})

describe('transform failures', () => {
  test('a throwing outbound is 502 transform_failed, and the upstream is never called', async () => {
    const { proxy } = await start({ scripted: { fail: 'BOOM' } })
    const res = await post(proxy.url, '/v1/messages', routed(), messages('BOOM now'))
    expect(res.status).toBe(502)
    expect(await errorType(res)).toBe('transform_failed')
    expect(upstream.requests).toHaveLength(0)
  })

  test('a failed factory is forgotten, and the next request retries it', async () => {
    const { proxy, probe } = await start({ scripted: { failFactories: 1 } })
    const first = await post(proxy.url, '/v1/messages', routed(), messages('Alice'))
    expect(first.status).toBe(502)
    expect(await errorType(first)).toBe('transform_failed')
    expect(upstream.requests).toHaveLength(0)

    const second = await post(proxy.url, '/v1/messages', routed(), messages('Alice'))
    expect(second.status).toBe(200)
    expect(probe.factories).toEqual(['default', 'default'])
  })

  test('concurrent first requests of one session share one build', async () => {
    const { proxy, probe } = await start({ scripted: { factoryDelayMs: 20 } })
    const [a, b] = await Promise.all([
      post(proxy.url, '/v1/messages', routed({ [SESSION_HEADER]: 's1' }), messages('Alice')),
      post(proxy.url, '/v1/messages', routed({ [SESSION_HEADER]: 's1' }), messages('Alice')),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(probe.factories).toEqual(['s1'])
  })
})

describe('sessions', () => {
  test('instances are per session', async () => {
    const { proxy, probe } = await start()
    await post(proxy.url, '/v1/messages', routed({ [SESSION_HEADER]: 's1' }), messages('Alice'))
    await post(proxy.url, '/v1/messages', routed({ [SESSION_HEADER]: 's2' }), messages('Alice'))
    expect(probe.factories).toEqual(['s1', 's2'])
  })

  test('facts published for a session reach that session transforms', async () => {
    const { proxy, probe } = await start()
    proxy.session('s1').publisher('connector.patients').publish([{ kind: 'NAME_PATIENT', value: 'Alice' }])
    await post(proxy.url, '/v1/messages', routed({ [SESSION_HEADER]: 's1' }), messages('Alice'))
    await post(proxy.url, '/v1/messages', routed({ [SESSION_HEADER]: 's2' }), messages('Alice'))
    const userCalls = probe.outbound.filter((call) => call.text === 'Alice' && call.leaf.kind === 'user')
    expect(userCalls.map((call) => call.facts)).toEqual([['NAME_PATIENT:Alice'], []])
  })

  test('dropSession disposes the instances and forgets facts; the next request rebuilds', async () => {
    const { proxy, probe } = await start()
    const headers = routed({ [SESSION_HEADER]: 's1' })
    await post(proxy.url, '/v1/messages', headers, messages('Alice'))
    proxy.session('s1').publisher('connector.patients').publish([{ kind: 'NAME_PATIENT', value: 'Alice' }])

    await proxy.dropSession('s1')
    expect(probe.disposed).toEqual(['s1'])
    expect(proxy.session('s1').facts.list()).toEqual([])

    await post(proxy.url, '/v1/messages', headers, messages('Alice'))
    expect(probe.factories).toEqual(['s1', 's1'])
  })
})

describe('createTransformProxy startup', () => {
  test('refuses a non-loopback host without a token', async () => {
    await expect(
      createTransformProxy({ host: '0.0.0.0', baseDir: process.cwd(), transforms: {}, pipelines: {} }),
    ).rejects.toThrow(/not loopback/)
  })

  test('refuses a pipeline that names an unknown transform', async () => {
    await expect(
      createTransformProxy({
        baseDir: process.cwd(),
        transforms: {},
        pipelines: { anon: ['nope'] },
        port: 0,
      }),
    ).rejects.toThrow(/unknown transform "nope"/)
  })

  test('refuses an unknown default pipeline', async () => {
    await expect(
      createTransformProxy({ baseDir: process.cwd(), transforms: {}, pipelines: {}, defaultPipeline: 'x', port: 0 }),
    ).rejects.toThrow(/defaultPipeline "x"/)
  })

  test('rejects when a transform fails to open, naming the transform', async () => {
    await expect(
      createTransformProxy({
        baseDir: process.cwd(),
        transforms: {
          broken: {
            module: {
              id: 'broken',
              open: async () => {
                throw new Error('bad config')
              },
            },
          },
        },
        pipelines: {},
        port: 0,
      }),
    ).rejects.toThrow(/transform "broken" failed to open: bad config/)
  })
})
