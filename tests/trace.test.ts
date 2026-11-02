import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { parseProxyConfig } from '../src/config.ts'
import {
  createFileTraceSink,
  createTransformProxy,
  DEFAULT_TRACE_MAX_CHARS,
  serializeTraceEvent,
  SESSION_HEADER,
  UPSTREAM_HEADER,
  type Logger,
  type TraceEvent,
  type TraceSink,
  type TransformProxy,
} from '../src/index.ts'
import { scriptedModule, startFakeUpstream, type FakeUpstream } from './support.ts'

let root: string
let upstream: FakeUpstream
let proxy: TransformProxy | undefined

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'stp-trace-'))
  upstream = await startFakeUpstream()
})

afterEach(async () => {
  await proxy?.close()
  proxy = undefined
  await upstream.close()
  rmSync(root, { recursive: true, force: true })
})

interface Captured {
  readonly events: TraceEvent[]
  readonly errors: string[]
}

async function start(trace: TraceSink | undefined): Promise<{ proxy: TransformProxy; errors: string[] }> {
  const { module } = scriptedModule()
  const errors: string[] = []
  const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: (msg) => errors.push(msg) }
  proxy = await createTransformProxy({
    baseDir: process.cwd(),
    transforms: { scripted: { module } },
    pipelines: { anon: ['scripted'] },
    defaultPipeline: 'anon',
    log,
    ...(trace === undefined ? {} : { trace }),
  })
  return { proxy, errors }
}

async function startCapturing(): Promise<Captured & { proxy: TransformProxy }> {
  const events: TraceEvent[] = []
  const { proxy, errors } = await start({ record: (event) => events.push(event) })
  return { proxy, events, errors }
}

const TOOLS = [{ name: 'lookup', description: 'Looks up Alice', input_schema: { type: 'object' } }]

function conversation(turns: readonly { role: string; content: string }[]): string {
  return JSON.stringify({ model: 'claude-test', max_tokens: 64, system: 'You help Alice.', tools: TOOLS, messages: turns })
}

function send(base: string, body: string, session = 's1', query = ''): Promise<Response> {
  return fetch(`${base}/v1/messages${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [UPSTREAM_HEADER]: upstream.url, [SESSION_HEADER]: session },
    body,
  })
}

const ROUND_1 = [{ role: 'user', content: 'Hello, I am Alice.' }]
const ROUND_2 = [...ROUND_1, { role: 'assistant', content: 'Hi P1.' }, { role: 'user', content: 'Alice again.' }]

function requests(events: readonly TraceEvent[]): TraceEvent[] {
  return events.filter((event) => event.phase === 'request')
}

describe('request trace', () => {
  test('round 1 traces every message and top-level field after the pipeline; round 2 only the new messages', async () => {
    const { proxy, events } = await startCapturing()
    expect((await send(proxy.url, conversation(ROUND_1), 's1', '?beta=true')).status).toBe(200)
    expect((await send(proxy.url, conversation(ROUND_2))).status).toBe(200)

    const [first, second] = requests(events)
    expect(first).toMatchObject({
      sessionId: 's1',
      pipeline: 'anon',
      route: 'anthropic.messages',
      upstream: `${upstream.url}/v1/messages`,
      model: 'claude-test',
      phase: 'request',
      leaks: [],
    })
    expect(Number.isNaN(Date.parse(first!.at))).toBe(false)
    expect(first!.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(second!.requestId).not.toBe(first!.requestId)

    const sent = JSON.parse(upstream.requests[0]!.body) as Record<string, unknown>
    const delta1 = first!.content as Record<string, unknown>
    expect(Object.keys(delta1).sort()).toEqual(['max_tokens', 'messages[0]', 'model', 'system', 'tools'])
    // What was sent upstream, i.e. after the pipeline: placeholders, never the original.
    expect(delta1['messages[0]']).toEqual((sent.messages as unknown[])[0])
    expect(delta1.system).toEqual(sent.system)
    expect(JSON.stringify(delta1['messages[0]'])).toContain('P1')
    expect(JSON.stringify(delta1['messages[0]'])).not.toContain('Alice')

    const sent2 = JSON.parse(upstream.requests[1]!.body) as { messages: unknown[] }
    expect(second!.content).toEqual({ 'messages[1]': sent2.messages[1], 'messages[2]': sent2.messages[2] })
  })

  test('an identical repeat traces {}; sessions are separate; dropSession forgets what was traced', async () => {
    const { proxy, events } = await startCapturing()
    await send(proxy.url, conversation(ROUND_1))
    await send(proxy.url, conversation(ROUND_1))
    await send(proxy.url, conversation(ROUND_1), 's2')
    await proxy.dropSession('s1')
    await send(proxy.url, conversation(ROUND_1))

    const deltas = requests(events).map((event) => Object.keys(event.content as object).sort())
    const full = ['max_tokens', 'messages[0]', 'model', 'system', 'tools']
    expect(deltas).toEqual([full, [], full, full])
  })

  test('a throwing sink is logged and the client response is unchanged', async () => {
    const { proxy, errors } = await start({
      record: () => {
        throw new Error('disk full')
      },
    })
    const res = await send(proxy.url, conversation(ROUND_1))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
    expect(upstream.requests).toHaveLength(1)
    expect(errors).toContain('transform proxy: trace sink failed: disk full')
  })

  test('without a sink nothing is traced and the request is forwarded as before', async () => {
    const { proxy, errors } = await start(undefined)
    expect((await send(proxy.url, conversation(ROUND_1))).status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    expect(errors).toEqual([])
  })
})

function event(content: unknown, sessionId = 's1'): TraceEvent {
  return {
    at: '2026-11-02T10:00:00.000Z',
    requestId: 'r1',
    sessionId,
    pipeline: 'anon',
    route: 'anthropic.messages',
    upstream: 'https://api.anthropic.com/v1/messages',
    phase: 'request',
    content,
    leaks: [],
  }
}

describe('serializeTraceEvent', () => {
  test('keeps content within maxChars; cuts longer content to its JSON text and marks it truncated', () => {
    expect(JSON.parse(serializeTraceEvent(event({ a: 'x' }), 100))).toEqual(event({ a: 'x' }))
    const long = { text: 'y'.repeat(50) }
    const cut = JSON.parse(serializeTraceEvent(event(long), 20)) as TraceEvent
    expect(cut.content).toBe(JSON.stringify(long).slice(0, 20))
    expect(cut.truncated).toBe(true)
    expect(serializeTraceEvent(event(undefined))).not.toContain('\n')
    expect(DEFAULT_TRACE_MAX_CHARS).toBe(262_144)
  })
})

describe('createFileTraceSink', () => {
  test('appends one line per event to <dir>/<session>.jsonl, dir 0700, file 0600', () => {
    const dir = join(root, 'nested', 'traces')
    const sink = createFileTraceSink({ dir, maxChars: 10 })
    sink.record(event({ n: 1 }))
    sink.record(event({ text: 'z'.repeat(40) }))
    const file = join(dir, 's1.jsonl')
    const lines = readFileSync(file, 'utf8').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('')
    expect(JSON.parse(lines[0]!).content).toEqual({ n: 1 })
    expect(JSON.parse(lines[1]!).truncated).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('an unsafe session id maps to sha256-<32 hex>', () => {
    const sink = createFileTraceSink({ dir: root })
    sink.record(event({}, '../etc/passwd'))
    sink.record(event({}, 'x'.repeat(129)))
    const names = readdirSync(root)
    expect(names).toHaveLength(2)
    for (const name of names) expect(name).toMatch(/^sha256-[0-9a-f]{32}\.jsonl$/)
  })
})

describe('config trace', () => {
  test('dir resolves against the config dir; maxChars is optional', () => {
    expect(parseProxyConfig({ trace: { dir: 'traces' } }, '/cfg').trace).toEqual({ dir: '/cfg/traces' })
    expect(parseProxyConfig({ trace: { dir: '/abs', maxChars: 5 } }, '/cfg').trace).toEqual({ dir: '/abs', maxChars: 5 })
    expect(parseProxyConfig({}, '/cfg').trace).toBeUndefined()
  })

  test('rejects a bad trace section', () => {
    expect(() => parseProxyConfig({ trace: 'x' }, '/cfg')).toThrow('trace must be a mapping with a dir')
    expect(() => parseProxyConfig({ trace: {} }, '/cfg')).toThrow('trace.dir must be a non-empty string')
    expect(() => parseProxyConfig({ trace: { dir: '' } }, '/cfg')).toThrow('trace.dir must be a non-empty string')
    expect(() => parseProxyConfig({ trace: { dir: 'd', maxChars: 0 } }, '/cfg')).toThrow('trace.maxChars must be a positive integer')
    expect(() => parseProxyConfig({ trace: { dir: 'd', maxChars: 1.5 } }, '/cfg')).toThrow('trace.maxChars must be a positive integer')
    expect(() => parseProxyConfig({ trace: { dir: 'd', max: 1 } }, '/cfg')).toThrow('unknown key "trace.max"')
  })
})

describe('cli trace dir', () => {
  async function run(argv: readonly string[], env: Record<string, string> = {}): Promise<{ stderr: string[]; stdout: string[] }> {
    const stdout: string[] = []
    const stderr: string[] = []
    const result = await runCli(argv, { cwd: root, home: join(root, 'home'), env, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) })
    proxy = result.proxy
    if (proxy !== undefined) {
      await send(proxy.url, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
      await proxy.close()
      proxy = undefined
    }
    return { stdout, stderr }
  }

  function writeConfig(body: string): string {
    const path = join(root, 'proxy.yaml')
    writeFileSync(path, `pipelines:\n  plain: []\ndefaultPipeline: plain\n${body}`)
    return path
  }

  test('--trace-dir resolves against cwd and wins over the config; the env var wins over both', async () => {
    const config = writeConfig('trace:\n  dir: from-config\n')

    const fromConfig = await run(['--config', config])
    expect(fromConfig.stderr).toEqual([`[transform-proxy info] trace: ${join(root, 'from-config')}`])
    expect(fromConfig.stdout[0]).toStartWith('listening http://127.0.0.1:')
    expect(readFileSync(join(root, 'from-config', 's1.jsonl'), 'utf8')).toContain('"phase":"request"')

    const fromFlag = await run(['--config', config, '--trace-dir', 'from-flag'])
    expect(fromFlag.stderr).toEqual([`[transform-proxy info] trace: ${join(root, 'from-flag')}`])

    const fromEnv = await run(['--config', config, '--trace-dir', 'from-flag'], { SKAILE_TRANSFORM_PROXY_TRACE_DIR: 'from-env' })
    expect(fromEnv.stderr).toEqual([`[transform-proxy info] trace: ${join(root, 'from-env')}`])
    expect(readFileSync(join(root, 'from-env', 's1.jsonl'), 'utf8')).toContain('"phase":"request"')
  })

  test('no trace dir: no trace line, no files', async () => {
    const config = writeConfig('')
    const { stderr } = await run(['--config', config])
    expect(stderr).toEqual([])
  })
})
