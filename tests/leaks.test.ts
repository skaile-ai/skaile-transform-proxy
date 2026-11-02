import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { findLeaks, type KnownOriginal } from '../src/leaks.ts'
import {
  createTransformProxy,
  SESSION_HEADER,
  UPSTREAM_HEADER,
  type Logger,
  type TraceEvent,
  type TraceSink,
  type TransformModule,
  type TransformProxy,
} from '../src/index.ts'
import { scriptedModule, startFakeUpstream, type FakeUpstream } from './support.ts'

const PERSON: KnownOriginal = { kind: 'person', source: 'crm', value: 'Alice Smith' }

describe('findLeaks', () => {
  test('reports the JSON path of every string that contains an original, through nested arrays and objects', () => {
    const body = {
      messages: [
        { role: 'user', content: 'nothing here' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'I am Alice Smith' }] },
      ],
      tools: [{ name: 'lookup', input_schema: { properties: { name: { description: 'e.g. Alice Smith' } } } }],
      system: 'Alice Smith',
    }
    expect(findLeaks(body, [PERSON])).toEqual([
      { kind: 'person', source: 'crm', at: 'messages[1].content[1].text' },
      { kind: 'person', source: 'crm', at: 'tools[0].input_schema.properties.name.description' },
      { kind: 'person', source: 'crm', at: 'system' },
    ])
  })

  test('keys that are not identifiers render as ["key"]; object keys themselves are not scanned', () => {
    const body = { metadata: { 'user-id': 'Alice Smith', 'Alice Smith': 'x', $ok: ['Alice Smith'], '0': 'Alice Smith' } }
    expect(findLeaks(body, [PERSON]).map((leak) => leak.at)).toEqual([
      'metadata["0"]',
      'metadata["user-id"]',
      'metadata.$ok[0]',
    ])
    expect(findLeaks(['Alice Smith'], [PERSON]).map((leak) => leak.at)).toEqual(['[0]'])
  })

  test('skips originals shorter than 3 characters and matches case-sensitively', () => {
    const originals: KnownOriginal[] = [
      { kind: 'initials', source: 'crm', value: 'AS' },
      { kind: 'empty', source: 'crm', value: '' },
      { kind: 'city', source: 'crm', value: 'Ulm' },
    ]
    expect(findLeaks({ text: 'AS from Ulm, not ulm' }, originals)).toEqual([{ kind: 'city', source: 'crm', at: 'text' }])
    expect(findLeaks({ text: 'alice smith' }, [PERSON])).toEqual([])
  })

  test('dedupes by kind, source and path; different kinds or sources at one path are separate findings', () => {
    const originals: KnownOriginal[] = [
      PERSON,
      { kind: 'person', source: 'crm', value: 'Smith' },
      { kind: 'person', source: 'ldap', value: 'Alice' },
      { kind: 'surname', source: 'crm', value: 'Smith' },
    ]
    expect(findLeaks({ text: 'Alice Smith and Alice Smith' }, originals)).toEqual([
      { kind: 'person', source: 'crm', at: 'text' },
      { kind: 'person', source: 'ldap', at: 'text' },
      { kind: 'surname', source: 'crm', at: 'text' },
    ])
  })

  test('the result never carries the value', () => {
    const result = findLeaks({ a: ['x Alice Smith y'], b: { c: 'Alice Smith' } }, [PERSON])
    expect(result).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('Alice')
    expect(JSON.stringify(result)).not.toContain('Smith')
  })

  test('numbers, booleans and null are not strings and never match', () => {
    expect(findLeaks({ n: 12345, b: true, z: null }, [{ kind: 'id', source: 'crm', value: '12345' }])).toEqual([])
  })
})

describe('leak check in the proxy', () => {
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

  interface Logged {
    readonly level: string
    readonly args: unknown[]
  }

  async function start(
    trace?: TraceSink,
    originals?: () => Iterable<{ kind: string; value: string }>,
  ): Promise<{ proxy: TransformProxy; logged: Logged[] }> {
    const scripted = scriptedModule().module
    const module: TransformModule =
      originals === undefined
        ? scripted
        : {
            id: scripted.id,
            open: async (config, ctx) => {
              const factory = await scripted.open(config, ctx)
              return async (session) => ({ ...(await factory(session)), knownOriginals: originals })
            },
          }
    const logged: Logged[] = []
    const log: Logger = {
      debug: (...args) => logged.push({ level: 'debug', args }),
      info: (...args) => logged.push({ level: 'info', args }),
      warn: (...args) => logged.push({ level: 'warn', args }),
      error: (...args) => logged.push({ level: 'error', args }),
    }
    proxy = await createTransformProxy({
      baseDir: process.cwd(),
      transforms: { scripted: { module } },
      pipelines: { anon: ['scripted'] },
      defaultPipeline: 'anon',
      log,
      ...(trace === undefined ? {} : { trace }),
    })
    return { proxy, logged }
  }

  // The scripted transform turns `Alice` into `P1` in message text; tools reach no transform.
  const BODY = JSON.stringify({
    model: 'claude-test',
    max_tokens: 64,
    tools: [{ name: 'lookup', description: 'Finds Alice Smith in the CRM', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'Hello, I am Alice Smith.' }],
  })
  const LEAKS = [{ kind: 'person', source: 'crm', at: 'tools[0].description' }]

  function send(base: string): Promise<Response> {
    return fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [UPSTREAM_HEADER]: upstream.url, [SESSION_HEADER]: 's1' },
      body: BODY,
    })
  }

  test('a fact value in tools is warned about with kind, source and path, never the value; the request still goes upstream', async () => {
    const { proxy, logged } = await start()
    proxy.session('s1').publisher('crm').publish([{ kind: 'person', value: 'Alice Smith' }])
    expect((await send(proxy.url)).status).toBe(200)

    const warns = logged.filter((entry) => entry.level === 'warn')
    expect(warns).toEqual([
      { level: 'warn', args: ['transform proxy: known original sent upstream', { sessionId: 's1', route: 'anthropic.messages', leaks: LEAKS }] },
    ])
    expect(JSON.stringify(logged)).not.toContain('Alice Smith')

    expect(upstream.requests).toHaveLength(1)
    const sent: unknown = JSON.parse(upstream.requests[0]!.body)
    expect(sent).toMatchObject({ tools: [{ description: 'Finds Alice Smith in the CRM' }], messages: [{ content: 'Hello, I am P1 Smith.' }] })
  })

  test('with a trace sink the request event carries the same findings', async () => {
    const events: TraceEvent[] = []
    const { proxy } = await start({ record: (event) => events.push(event) })
    proxy.session('s1').publisher('crm').publish([{ kind: 'person', value: 'Alice Smith' }])
    expect((await send(proxy.url)).status).toBe(200)

    const request = events.find((event) => event.phase === 'request')
    expect(request?.leaks).toEqual(LEAKS)
    expect(upstream.requests).toHaveLength(1)
  })

  test('no facts warn nothing; a fact the pipeline replaced in the messages is found only where it survived', async () => {
    const { proxy, logged } = await start()
    expect((await send(proxy.url)).status).toBe(200)
    proxy.session('s1').publisher('crm').publish([{ kind: 'person', value: 'Alice' }])
    // `Alice` survives only inside `tools`, so that is the one finding; messages carry `P1`.
    expect((await send(proxy.url)).status).toBe(200)
    const warns = logged.filter((entry) => entry.level === 'warn')
    expect(warns.map((entry) => entry.args[1])).toEqual([{ sessionId: 's1', route: 'anthropic.messages', leaks: LEAKS }])
  })

  test('an original the pipeline reports via knownOriginals is found in tools with source pipeline, never the value', async () => {
    const { proxy, logged } = await start(undefined, () => [{ kind: 'person', value: 'Alice Smith' }])
    expect((await send(proxy.url)).status).toBe(200)
    const warns = logged.filter((entry) => entry.level === 'warn')
    expect(warns).toEqual([
      {
        level: 'warn',
        args: [
          'transform proxy: known original sent upstream',
          { sessionId: 's1', route: 'anthropic.messages', leaks: [{ kind: 'person', source: 'pipeline', at: 'tools[0].description' }] },
        ],
      },
    ])
    expect(JSON.stringify(logged)).not.toContain('Alice Smith')
    expect(upstream.requests).toHaveLength(1)
  })

  test('a throwing knownOriginals does not fail the request; the facts are still checked', async () => {
    const { proxy, logged } = await start(undefined, () => {
      throw new Error('boom')
    })
    proxy.session('s1').publisher('crm').publish([{ kind: 'person', value: 'Alice Smith' }])
    expect((await send(proxy.url)).status).toBe(200)
    const warns = logged.filter((entry) => entry.level === 'warn')
    expect(warns.map((entry) => entry.args[1])).toEqual([{ sessionId: 's1', route: 'anthropic.messages', leaks: LEAKS }])
  })
})
