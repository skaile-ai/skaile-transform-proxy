import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import anonExtension, { createAnonController, defaultStatePath, ompImageSending, registerAnonExtension } from '../src/omp/index.ts'
import type { AnonController, AnonControllerDeps, ImageSending, ProxySpawnOptions } from '../src/omp/index.ts'
import type {
  OmpAutocompleteItem,
  OmpContext,
  OmpEventName,
  OmpExtensionApi,
  OmpModel,
  OmpModelRegistry,
  OmpNotifyType,
  OmpSessionActions,
} from '../src/omp/types.ts'

const UPSTREAM = 'x-skaile-transform-upstream'
const SESSION = 'x-skaile-transform-session'
const TOKEN = 'x-skaile-transform-token'

let root: string
let statePath: string
/** Children spawned by a test (fake or real node); afterEach kills the ones still running. */
const children: { kill(): boolean; readonly exitCode?: number | null; readonly signalCode?: string | null }[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stp-omp-'))
  statePath = join(root, 'agent', 'skaile-transform-proxy.json')
})

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  rmSync(root, { recursive: true, force: true })
})

interface StaticProvider {
  readonly baseUrl?: string
  readonly headers?: Record<string, string>
  readonly apis: readonly string[]
}

interface Override {
  baseUrl?: string
  headers?: Record<string, string>
}

/**
 * Mirrors omp's ModelRegistry override semantics: registerProvider merges into the runtime override;
 * a new sourceId takes the provider over and drops the previous source's state; clearSourceRegistrations
 * drops the runtime override of every provider the source owns.
 */
class FakeRegistry implements OmpModelRegistry {
  readonly runtime = new Map<string, Override>()
  readonly owners = new Map<string, string>()
  readonly calls: string[] = []
  constructor(readonly statics: Record<string, StaticProvider>) {}

  /** Fresh model objects on every call, like omp's re-projection: one model per api, id `<provider>-<n>`, provider headers projected. */
  getAll(): OmpModel[] {
    return Object.entries(this.statics).flatMap(([provider, spec]) =>
      spec.apis.map((api, index) => {
        const baseUrl = this.getProviderBaseUrl(provider)
        const headers = this.getProviderHeaders(provider)
        return {
          provider,
          id: `${provider}-${index}`,
          api,
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(headers === undefined ? {} : { headers }),
        }
      }),
    )
  }
  find(provider: string, modelId: string): OmpModel | undefined {
    return this.getAll().find((model) => model.provider === provider && model.id === modelId)
  }
  getProviderBaseUrl(provider: string): string | undefined {
    return this.runtime.get(provider)?.baseUrl ?? this.statics[provider]?.baseUrl
  }
  getProviderHeaders(provider: string): Record<string, string> | undefined {
    const merged = { ...this.statics[provider]?.headers, ...this.runtime.get(provider)?.headers }
    return Object.keys(merged).length === 0 ? undefined : merged
  }
  registerProvider(name: string, config: Override, sourceId?: string): void {
    this.calls.push(sourceId === undefined ? `register ${name}` : `register ${name} ${sourceId}`)
    if (sourceId !== undefined) {
      const owner = this.owners.get(name)
      if (owner !== undefined && owner !== sourceId) this.runtime.delete(name)
      this.owners.set(name, sourceId)
    }
    const previous = this.runtime.get(name)
    this.runtime.set(name, {
      baseUrl: config.baseUrl ?? previous?.baseUrl,
      headers: config.headers === undefined ? previous?.headers : { ...previous?.headers, ...config.headers },
    })
  }
  clearSourceRegistrations(sourceId: string): void {
    this.calls.push(`clear ${sourceId}`)
    for (const [name, owner] of this.owners) {
      if (owner !== sourceId) continue
      this.owners.delete(name)
      this.runtime.delete(name)
    }
  }
}

interface FakeContext extends OmpContext, OmpSessionActions {
  readonly notes: { message: string; type?: OmpNotifyType }[]
  readonly statuses: (string | undefined)[]
  /** Models passed to `setModel`. */
  readonly rebinds: OmpModel[]
  active: OmpModel | undefined
}

interface ContextOptions {
  readonly sessionId?: () => string
  readonly active?: OmpModel
  readonly setModelResult?: boolean | 'throw'
  /** omp's root sessions have a UI (tui) or run in rpc/json mode; subagents are headless `print`. */
  readonly hasUI?: boolean
  readonly mode?: string
}

function context(registry: OmpModelRegistry, options: ContextOptions = {}): FakeContext {
  const notes: { message: string; type?: OmpNotifyType }[] = []
  const statuses: (string | undefined)[] = []
  const rebinds: OmpModel[] = []
  return {
    notes,
    statuses,
    rebinds,
    active: options.active,
    get model() {
      return this.active
    },
    async setModel(model) {
      rebinds.push(model)
      if (options.setModelResult === 'throw') throw new Error('model switch failed')
      if (options.setModelResult === false) return false
      this.active = model
      return true
    },
    cwd: root,
    modelRegistry: registry,
    sessionManager: { getSessionId: options.sessionId ?? (() => 'omp-session-1') },
    ...(options.hasUI === undefined ? {} : { hasUI: options.hasUI }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ui: {
      notify: (message, type) => notes.push(type === undefined ? { message } : { message, type }),
      setStatus: (key, text) => {
        expect(key).toBe('anon')
        statuses.push(text)
      },
    },
  }
}

/** The `before_provider_request` context of a request made with `model` (omp passes the request's model). */
function requestContext(ctx: FakeContext, model: OmpModel | undefined): FakeContext {
  return { ...ctx, active: model, model }
}

function standardRegistry(): FakeRegistry {
  return new FakeRegistry({
    anthropic: { baseUrl: 'https://api.anthropic.com', headers: { 'x-team': 'a' }, apis: ['anthropic-messages'] },
    openai: { baseUrl: 'https://api.openai.com/v1', apis: ['openai-responses', 'openai-completions'] },
    bedrock: { baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', apis: ['bedrock-converse-stream'] },
    vertex: { apis: ['google-vertex'] },
  })
}

const ENV_PROXY = { SKAILE_TRANSFORM_PROXY_URL: 'http://127.0.0.1:7001', SKAILE_TRANSFORM_PROXY_TOKEN: 'tok' }

/** The controller, with each fake context doubling as its session's `setModel` action. */
interface TestController {
  readonly inner: AnonController
  command(args: string, ctx: FakeContext): Promise<void>
  completions(prefix: string): OmpAutocompleteItem[] | null
  sessionStart(ctx: FakeContext): Promise<void>
  sessionSwitch(ctx: FakeContext): Promise<void>
  reapply(ctx: FakeContext): Promise<void>
  providerRequest(ctx: FakeContext): unknown
}

function controller(env: Record<string, string | undefined> = ENV_PROXY, extra: Partial<AnonControllerDeps> = {}): TestController {
  const inner = createAnonController({ env, home: join(root, 'home'), statePath, ...extra })
  return {
    inner,
    command: (args, ctx) => inner.command(args, ctx, ctx),
    completions: (prefix) => inner.completions(prefix),
    sessionStart: (ctx) => inner.sessionStart(ctx, ctx),
    sessionSwitch: (ctx) => inner.sessionSwitch(ctx, ctx),
    reapply: (ctx) => inner.reapply(ctx, ctx),
    providerRequest: (ctx) => inner.providerRequest(ctx),
  }
}

function persisted(): unknown {
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

function lastNote(ctx: FakeContext): string {
  return ctx.notes.at(-1)?.message ?? ''
}

/** A spawned proxy child driven by the test: write to `stdout`/`stderr`, then `exit` or emit `error`. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: (NodeJS.Signals | number | undefined)[] = []
  exitCode: number | null = null
  signalCode: string | null = null
  unrefs = 0
  constructor(readonly pid: number) {
    super()
    children.push(this)
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal)
    this.exit(null, typeof signal === 'string' ? signal : 'SIGTERM')
    return true
  }
  unref(): void {
    this.unrefs++
  }
  /** Like a real process: its stdout and stderr pipes close, then `exit` fires. */
  exit(code: number | null, signal: string | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, signal)
  }
  listen(url = 'http://127.0.0.1:7123'): void {
    this.stdout.write(`listening ${url}\n`)
  }
}

interface SpawnCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: ProxySpawnOptions
  readonly child: FakeChild
}

/** A `spawnChild` that records its calls; `behave` drives each new child on the next tick (default: it starts listening). */
function fakeSpawner(behave: (child: FakeChild, call: SpawnCall) => void = (child) => child.listen()): {
  readonly calls: SpawnCall[]
  readonly spawnChild: NonNullable<AnonControllerDeps['spawnChild']>
} {
  const calls: SpawnCall[] = []
  return {
    calls,
    spawnChild: (command, args, options) => {
      const child = new FakeChild(4242 + calls.length)
      const call = { command, args, options, child }
      calls.push(call)
      queueMicrotask(() => behave(child, call))
      return child
    },
  }
}

const CLI = '/pkg/dist/cli.mjs'
const CONFIG = 'pipelines:\n  plain: []\ndefaultPipeline: plain\n'

function writeConfig(dir: string, body = CONFIG): string {
  mkdirSync(join(dir, '.skaile'), { recursive: true })
  const path = join(dir, '.skaile', 'transform-proxy.yaml')
  writeFileSync(path, body)
  return path
}

describe('/anon command parsing', () => {
  test('completes the verbs and their --global forms by prefix', () => {
    const anon = controller()
    expect(anon.completions('')?.map((item) => item.value)).toEqual(['on', 'on --global', 'off', 'off --global', 'status'])
    expect(anon.completions('off')?.map((item) => item.value)).toEqual(['off', 'off --global'])
    expect(anon.completions(' ST')?.map((item) => item.value)).toEqual(['status'])
    expect(anon.completions('x')).toBeNull()
  })

  for (const args of ['maybe', 'on --globl', 'on --global --global', 'status --global']) {
    test(`"${args}" notifies the usage and changes nothing`, async () => {
      const registry = standardRegistry()
      const ctx = context(registry)
      await controller().command(args, ctx)
      expect(ctx.notes).toEqual([{ message: 'usage: /anon on|off [--global] | status', type: 'error' }])
      expect(registry.calls).toEqual([])
      expect(ctx.statuses).toEqual(['🔴A'])
      expect(existsSync(statePath)).toBe(false)
    })
  }

  test('verbs are trimmed and case-insensitive; an empty argument shows the status', async () => {
    const ctx = context(standardRegistry())
    const anon = controller()
    await anon.command('  ON ', ctx)
    expect(ctx.statuses.at(-1)).toBe('🟢A')
    await anon.command('', ctx)
    expect(lastNote(ctx)).toStartWith('anon on')
  })
})

describe('/anon on with SKAILE_TRANSFORM_PROXY_URL', () => {
  test('routes every provider through the env proxy with upstream, session and token headers', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    let spawns = 0
    await controller(ENV_PROXY, { spawnChild: () => (spawns++, new FakeChild(1)) }).command('on', ctx)

    expect(spawns).toBe(0)
    expect(registry.calls).toEqual(['anthropic', 'openai', 'bedrock', 'vertex'].map((name) => `register ${name} skaile-transform-proxy`))
    expect(registry.getProviderBaseUrl('anthropic')).toBe('http://127.0.0.1:7001')
    expect(registry.getProviderHeaders('anthropic')).toEqual({
      'x-team': 'a',
      [SESSION]: 'omp-session-1',
      [UPSTREAM]: 'https://api.anthropic.com',
      [TOKEN]: 'tok',
    })
    expect(registry.getProviderHeaders('openai')?.[UPSTREAM]).toBe('https://api.openai.com/v1')
    // No base URL to name as upstream: routed anyway, and the proxy refuses it.
    expect(registry.getProviderBaseUrl('vertex')).toBe('http://127.0.0.1:7001')
    expect(registry.getProviderHeaders('vertex')?.[UPSTREAM]).toBeUndefined()
    expect(ctx.statuses).toEqual(['🟢A'])
    expect(lastNote(ctx)).toBe('anon on (this session): 4 provider(s) routed through http://127.0.0.1:7001')
    expect(existsSync(statePath)).toBe(false)
  })

  test('no token header when SKAILE_TRANSFORM_PROXY_TOKEN is unset', async () => {
    const registry = standardRegistry()
    await controller({ SKAILE_TRANSFORM_PROXY_URL: 'http://127.0.0.1:7001' }).command('on', context(registry))
    expect(registry.getProviderHeaders('openai')).toEqual({ [SESSION]: 'omp-session-1', [UPSTREAM]: 'https://api.openai.com/v1' })
  })

  test('falls back to a random per-process session id when the session manager has none', async () => {
    const registry = standardRegistry()
    const anon = controller()
    await anon.command('on', context(registry, { sessionId: () => { throw new Error('no session') } }))
    const id = registry.getProviderHeaders('openai')?.[SESSION]
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    // A later session (a subagent) keeps the first id, so its requests share the proxy session state.
    registry.runtime.clear()
    await anon.sessionStart(context(registry, { sessionId: () => 'subagent' }))
    expect(registry.getProviderHeaders('openai')?.[SESSION]).toBe(id)
  })
})

describe('originals', () => {
  test('are recorded once: a second on, a reapply and an on after off never use proxied values', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const anon = controller()
    await anon.command('on', ctx)
    await anon.command('on', ctx)
    await anon.reapply(ctx)
    expect(registry.calls.filter((call) => call.startsWith('register'))).toHaveLength(4)
    await anon.command('off', ctx)
    await anon.command('on', ctx)
    expect(registry.getProviderHeaders('anthropic')?.[UPSTREAM]).toBe('https://api.anthropic.com')
    expect(registry.getProviderHeaders('openai')?.[UPSTREAM]).toBe('https://api.openai.com/v1')
  })

  test('reapply re-routes a provider whose override was reset and routes a provider that appeared', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const anon = controller()
    await anon.command('on', ctx)
    registry.runtime.delete('openai') // omp cleared runtime overrides (e.g. extension source sync)
    registry.statics.mistral = { baseUrl: 'https://api.mistral.ai/v1', apis: ['openai-completions'] }
    registry.calls.length = 0
    await anon.reapply(ctx)
    expect(registry.calls).toEqual(['register openai skaile-transform-proxy', 'register mistral skaile-transform-proxy'])
    expect(registry.getProviderHeaders('openai')?.[UPSTREAM]).toBe('https://api.openai.com/v1')
    expect(registry.getProviderBaseUrl('mistral')).toBe('http://127.0.0.1:7001')
  })

  test('reapply does nothing while off', async () => {
    const registry = standardRegistry()
    await controller().reapply(context(registry))
    expect(registry.calls).toEqual([])
  })

  test('a provider whose own config already targets a transform proxy is never re-registered', async () => {
    const registry = new FakeRegistry({
      skaile: { baseUrl: 'http://127.0.0.1:7001', headers: { [UPSTREAM]: 'https://api.anthropic.com' }, apis: ['anthropic-messages'] },
      openai: { baseUrl: 'https://api.openai.com/v1', apis: ['openai-completions'] },
    })
    const ctx = context(registry)
    const anon = controller()
    await anon.command('on', ctx)
    expect(registry.calls).toEqual(['register openai skaile-transform-proxy'])
    await anon.command('status', ctx)
    expect(lastNote(ctx)).toContain('routed by their own config (1): skaile')
    await anon.command('off', ctx)
    expect(registry.calls).toEqual(['register openai skaile-transform-proxy', 'clear skaile-transform-proxy'])
  })
})

describe('active model rebind', () => {
  test('on and off swap the session model for the re-projected one, so the next request takes the new base URL', async () => {
    const registry = standardRegistry()
    const ctx = context(registry, { active: registry.find('anthropic', 'anthropic-0') })
    const anon = controller()
    await anon.command('on', ctx)
    expect(ctx.rebinds.map((model) => model.baseUrl)).toEqual(['http://127.0.0.1:7001'])
    expect(ctx.model?.baseUrl).toBe('http://127.0.0.1:7001')
    await anon.command('off', ctx)
    expect(ctx.rebinds.map((model) => model.baseUrl)).toEqual(['http://127.0.0.1:7001', 'https://api.anthropic.com'])
  })

  test('no rebind without an active model, or when its base URL did not change', async () => {
    const registry = new FakeRegistry({
      skaile: { baseUrl: 'http://127.0.0.1:7001', headers: { [UPSTREAM]: 'https://api.anthropic.com' }, apis: ['anthropic-messages'] },
      openai: { baseUrl: 'https://api.openai.com/v1', apis: ['openai-completions'] },
    })
    const anon = controller()
    const idle = context(registry)
    await anon.command('on', idle)
    const preRouted = context(registry, { active: registry.find('skaile', 'skaile-0') })
    await anon.reapply(preRouted)
    expect([...idle.rebinds, ...preRouted.rebinds]).toEqual([])
  })

  test('a session whose model was reset is rebound on its next turn', async () => {
    const registry = standardRegistry()
    const anon = controller()
    await anon.command('on', context(registry))
    registry.runtime.delete('openai')
    const ctx = context(registry, { active: registry.find('openai', 'openai-1') })
    await anon.reapply(ctx)
    expect(ctx.model?.baseUrl).toBe('http://127.0.0.1:7001')
  })

  for (const result of [false, 'throw'] as const) {
    test(`/anon on with a failed rebind (${result}) is an activation failure: routes rolled back, nothing persisted, off`, async () => {
      const registry = standardRegistry()
      const ctx = context(registry, { active: registry.find('openai', 'openai-0'), setModelResult: result })
      const anon = controller()
      await anon.command('on', ctx)
      expect(ctx.notes).toEqual([
        { message: 'anon: could not rebind the active model openai/openai-0 to the transform proxy', type: 'error' },
      ])
      expect(ctx.statuses).toEqual(['🔴A'])
      expect(existsSync(statePath)).toBe(false)
      expect(registry.calls.at(-1)).toBe('clear skaile-transform-proxy')
      expect(registry.getProviderBaseUrl('openai')).toBe('https://api.openai.com/v1')
      expect(registry.getProviderHeaders('openai')).toBeUndefined()
      await anon.command('status', ctx)
      expect(lastNote(ctx)).toStartWith('anon off\n')
      // Off: requests are not touched.
      expect(anon.providerRequest(ctx)).toBeUndefined()
    })
  }

  test('required mode: a failed rebind shows anon error, keeps the routes and refuses the stale model\'s requests', async () => {
    const registry = standardRegistry()
    const stale = registry.find('openai', 'openai-0')
    const ctx = context(registry, { active: stale, setModelResult: false })
    const anon = controller({ ...ENV_PROXY, SKAILE_TRANSFORM_PROXY_MODE: 'required' })
    await anon.sessionStart(ctx)
    expect(ctx.statuses).toEqual(['🟠A'])
    expect(ctx.notes).toEqual([
      { message: 'anon: could not rebind the active model openai/openai-0 to the transform proxy', type: 'error' },
      { message: 'anon: required mode: model requests are refused until the transform proxy is routed (SKAILE_TRANSFORM_PROXY_MODE=required)', type: 'error' },
    ])
    expect(registry.getProviderBaseUrl('openai')).toBe('http://127.0.0.1:7001')
    expect(anon.providerRequest(requestContext(ctx, stale))).toEqual({})
    expect(lastNote(ctx)).toBe('anon: model request refused: openai/openai-0 does not target the transform proxy')
    expect(anon.providerRequest(requestContext(ctx, registry.find('openai', 'openai-0')))).toBeUndefined()
  })

  test('a rebind failing on a later turn turns anon on into anon error; the next good turn recovers', async () => {
    const registry = standardRegistry()
    const anon = controller()
    const first = context(registry)
    await anon.command('on', first)
    registry.runtime.delete('openai')
    const stale = registry.find('openai', 'openai-0')
    const broken = context(registry, { active: stale, setModelResult: false })
    await anon.reapply(broken)
    expect(broken.statuses).toEqual(['🟠A'])
    expect(broken.notes.map((note) => note.type)).toEqual(['error', 'error'])
    expect(registry.getProviderBaseUrl('anthropic')).toBe('https://api.anthropic.com')
    expect(anon.providerRequest(requestContext(broken, stale))).toEqual({})
    const healthy = context(registry, { active: stale })
    await anon.reapply(healthy)
    expect(healthy.statuses).toEqual(['🟢A'])
    expect(anon.providerRequest(requestContext(healthy, healthy.model))).toBeUndefined()
  })
})

describe('before_provider_request guard', () => {
  test('while on, a request whose model bypasses the proxy loses its payload; routed models pass', async () => {
    const registry = standardRegistry()
    const stale = registry.find('anthropic', 'anthropic-0')
    const ctx = context(registry)
    const anon = controller()
    expect(anon.providerRequest(requestContext(ctx, stale))).toBeUndefined()
    await anon.command('on', ctx)
    expect(anon.providerRequest(requestContext(ctx, registry.find('anthropic', 'anthropic-0')))).toBeUndefined()
    expect(anon.providerRequest(requestContext(ctx, stale))).toEqual({})
    expect(anon.providerRequest(requestContext(ctx, undefined))).toEqual({})
    await anon.command('off', ctx)
    expect(anon.providerRequest(requestContext(ctx, stale))).toBeUndefined()
  })

  test('a provider routed by its own config passes', async () => {
    const registry = new FakeRegistry({
      skaile: { baseUrl: 'http://127.0.0.1:7555', headers: { [UPSTREAM]: 'https://api.anthropic.com' }, apis: ['anthropic-messages'] },
    })
    const ctx = context(registry)
    const anon = controller({ ...ENV_PROXY, SKAILE_TRANSFORM_PROXY_MODE: 'required' })
    await anon.sessionStart(ctx)
    expect(anon.providerRequest(requestContext(ctx, registry.find('skaile', 'skaile-0')))).toBeUndefined()
  })
})

describe('/anon off', () => {
  test('clears the proxy source in one call, which drops the proxy headers, and saves nothing', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const anon = controller()
    await anon.command('on', ctx)
    await anon.command('off', ctx)
    expect(registry.calls.filter((call) => !call.startsWith('register'))).toEqual(['clear skaile-transform-proxy'])
    expect(registry.getProviderBaseUrl('anthropic')).toBe('https://api.anthropic.com')
    expect(registry.getProviderHeaders('anthropic')).toEqual({ 'x-team': 'a' })
    expect(registry.getProviderHeaders('openai')).toBeUndefined()
    expect(ctx.statuses).toEqual(['🟢A', '🔴A'])
    expect(lastNote(ctx)).toBe('anon off (this session): original provider base URLs restored')
    expect(existsSync(statePath)).toBe(false)
  })

  test('re-registers the recorded original when another runtime override sat underneath', async () => {
    const registry = standardRegistry()
    registry.registerProvider('openai', { baseUrl: 'https://corp-gateway.example/v1', headers: { 'x-corp': '1' } }, 'other-ext')
    const ctx = context(registry)
    const anon = controller()
    await anon.command('on', ctx)
    expect(registry.getProviderHeaders('openai')?.[UPSTREAM]).toBe('https://corp-gateway.example/v1')
    await anon.command('off', ctx)
    expect(registry.getProviderBaseUrl('openai')).toBe('https://corp-gateway.example/v1')
    expect(registry.getProviderHeaders('openai')).toEqual({ 'x-corp': '1' })
  })

  test('required mode refuses off and keeps every route', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const anon = controller({ ...ENV_PROXY, SKAILE_TRANSFORM_PROXY_MODE: 'required' })
    await anon.command('on', ctx)
    await anon.command('off', ctx)
    expect(ctx.notes.at(-1)).toEqual({
      message: 'anon: off refused: this session requires the transform proxy (SKAILE_TRANSFORM_PROXY_MODE=required)',
      type: 'warning',
    })
    expect(registry.calls.some((call) => call.startsWith('clear'))).toBe(false)
    expect(registry.getProviderBaseUrl('openai')).toBe('http://127.0.0.1:7001')
    expect(ctx.statuses.at(-1)).toBe('🟢A')
    expect(existsSync(statePath)).toBe(false)
  })
})

describe('/anon --global', () => {
  test('on --global saves the default; off --global saves off; plain verbs leave it alone', async () => {
    const ctx = context(standardRegistry())
    const anon = controller(ENV_PROXY)
    await anon.command('on --global', ctx)
    expect(lastNote(ctx)).toBe('anon on (this session; default for new sessions: on): 4 provider(s) routed through http://127.0.0.1:7001')
    expect(persisted()).toEqual({ enabled: true })
    await anon.command('off', ctx)
    expect(persisted()).toEqual({ enabled: true })
    await anon.command('OFF  --GLOBAL', ctx)
    expect(lastNote(ctx)).toBe('anon off (this session; default for new sessions: off): original provider base URLs restored')
    expect(persisted()).toEqual({ enabled: false })
    expect(ctx.statuses).toEqual(['🟢A', '🔴A', '🔴A'])
  })

  test('a failed on --global saves nothing', async () => {
    const ctx = context(standardRegistry(), { active: undefined })
    const anon = controller({}, { spawnChild: () => { throw Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) } })
    await anon.command('on --global', ctx)
    expect(ctx.statuses).toEqual(['🔴A'])
    expect(existsSync(statePath)).toBe(false)
  })

  test('after a plain off, a later session start ignores a saved on default', async () => {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ enabled: true }))
    const registry = standardRegistry()
    const ctx = context(registry)
    const anon = controller(ENV_PROXY)
    await anon.sessionStart(ctx)
    expect(ctx.statuses).toEqual(['🟢A'])
    await anon.command('off', ctx)
    await anon.sessionStart(ctx)
    expect(registry.getProviderBaseUrl('anthropic')).toBe('https://api.anthropic.com')
    expect(ctx.statuses).toEqual(['🟢A', '🔴A', '🔴A'])
    expect(persisted()).toEqual({ enabled: true })
  })
})

describe('/anon status', () => {
  test('lists state, proxy, pipeline, session, routed and refused providers', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const anon = controller()
    await anon.command('status', ctx)
    expect(lastNote(ctx)).toBe('anon off\ntrace: off\nrouted (0): none')
    await anon.command('on', ctx)
    await anon.command('status', ctx)
    expect(lastNote(ctx)).toBe(
      [
        'anon on',
        'proxy: http://127.0.0.1:7001 (SKAILE_TRANSFORM_PROXY_URL)',
        'pipeline: the proxy default',
        'session: omp-session-1',
        'trace: off',
        'routed (4): anthropic, bedrock, openai, vertex',
        'refused by the proxy (2): bedrock (bedrock-converse-stream), vertex (no base URL)',
      ].join('\n'),
    )
  })

  test('trace: the env dir, resolved against the cwd, also with an external proxy', async () => {
    const ctx = context(standardRegistry())
    const anon = controller({ ...ENV_PROXY, SKAILE_TRANSFORM_PROXY_TRACE_DIR: 'traces' })
    await anon.command('status', ctx)
    expect(lastNote(ctx)).toContain(`\ntrace: ${join(root, 'traces')}\n`)
  })

  test("trace: the own child's config trace.dir; the env dir wins over it", async () => {
    writeConfig(root, `${CONFIG}trace:\n  dir: from-config\n`)
    const ctx = context(standardRegistry())
    const anon = controller({}, { spawnChild: fakeSpawner().spawnChild, cliPath: CLI })
    await anon.command('on', ctx)
    await anon.command('status', ctx)
    expect(lastNote(ctx)).toContain(`\ntrace: ${join(root, '.skaile', 'from-config')}\n`)

    const ctx2 = context(standardRegistry())
    const spawner = fakeSpawner()
    const withEnv = controller({ SKAILE_TRANSFORM_PROXY_TRACE_DIR: '/tmp/env-traces' }, { spawnChild: spawner.spawnChild, cliPath: CLI })
    await withEnv.command('on', ctx2)
    await withEnv.command('status', ctx2)
    expect(lastNote(ctx2)).toContain('\ntrace: /tmp/env-traces\n')
    expect(spawner.calls[0]!.options.env.SKAILE_TRANSFORM_PROXY_TRACE_DIR).toBe('/tmp/env-traces')
  })
})

describe('session_start', () => {
  test('re-applies a persisted enabled flag', async () => {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ enabled: true }))
    const registry = standardRegistry()
    const ctx = context(registry)
    await controller().sessionStart(ctx)
    expect(registry.getProviderBaseUrl('anthropic')).toBe('http://127.0.0.1:7001')
    expect(ctx.statuses).toEqual(['🟢A'])
  })

  test('stays off without a flag, or with a corrupt one, and shows the off status', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    await controller().sessionStart(ctx)
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, '{not json')
    await controller().sessionStart(ctx)
    expect(registry.calls).toEqual([])
    expect(ctx.statuses).toEqual(['🔴A', '🔴A'])
  })

  test('required mode forces routing on even when the flag says off', async () => {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ enabled: false }))
    const registry = standardRegistry()
    const ctx = context(registry)
    await controller({ ...ENV_PROXY, SKAILE_TRANSFORM_PROXY_MODE: 'required' }).sessionStart(ctx)
    expect(registry.getProviderBaseUrl('openai')).toBe('http://127.0.0.1:7001')
    expect(ctx.statuses).toEqual(['🟢A'])
  })

  test('required mode without a reachable proxy shows anon error and refuses model requests', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const anon = controller({ SKAILE_TRANSFORM_PROXY_MODE: 'required' })
    await anon.sessionStart(ctx)
    expect(ctx.notes.map((note) => note.type)).toEqual(['error', 'error'])
    expect(ctx.notes[1]?.message).toBe('anon: required mode: model requests are refused until the transform proxy is routed (SKAILE_TRANSFORM_PROXY_MODE=required)')
    expect(ctx.statuses).toEqual(['🟠A'])
    expect(anon.providerRequest(requestContext(ctx, registry.find('openai', 'openai-0')))).toEqual({})
    expect(lastNote(ctx)).toBe('anon: model request refused: the transform proxy is not available')
  })
})

describe('session rotation', () => {
  test('a new root session re-routes every provider with its id, even when the proxy URL is unchanged', async () => {
    let id = 'root-1'
    const registry = standardRegistry()
    const anon = controller({ ...ENV_PROXY, SKAILE_TRANSFORM_PROXY_MODE: 'required' })
    const ctx = context(registry, { sessionId: () => id, hasUI: true, mode: 'tui', active: registry.find('anthropic', 'anthropic-0') })
    await anon.sessionStart(ctx)
    expect(registry.getProviderHeaders('anthropic')?.[SESSION]).toBe('root-1')
    id = 'root-2'
    await anon.sessionSwitch(ctx)
    for (const provider of ['anthropic', 'openai', 'bedrock', 'vertex']) {
      expect(registry.getProviderHeaders(provider)?.[SESSION]).toBe('root-2')
      expect(registry.getProviderBaseUrl(provider)).toBe('http://127.0.0.1:7001')
    }
    // The active model is rebound to the re-projected one carrying the new id.
    expect(ctx.model?.headers?.[SESSION]).toBe('root-2')
    expect(ctx.statuses.at(-1)).toBe('🟢A')
  })

  test('a root session_start with a new id rotates too; a subagent session keeps the parent id', async () => {
    let id = 'root-1'
    const registry = standardRegistry()
    const anon = controller({ ...ENV_PROXY, SKAILE_TRANSFORM_PROXY_MODE: 'required' })
    await anon.sessionStart(context(registry, { sessionId: () => id, hasUI: true, mode: 'tui' }))
    await anon.sessionStart(context(registry, { sessionId: () => 'sub-1', hasUI: false, mode: 'print' }))
    expect(registry.getProviderHeaders('openai')?.[SESSION]).toBe('root-1')
    id = 'root-2'
    await anon.sessionStart(context(registry, { sessionId: () => id, hasUI: false, mode: 'rpc' }))
    expect(registry.getProviderHeaders('openai')?.[SESSION]).toBe('root-2')
  })

  test('a child-process proxy is kept across a rotation: providers carry the new session id, nothing respawns', async () => {
    writeConfig(root)
    const spawner = fakeSpawner()
    const anon = controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI })
    let id = 'root-1'
    const registry = standardRegistry()
    const ctx = context(registry, { sessionId: () => id, hasUI: true, mode: 'tui' })
    await anon.command('on', ctx)
    id = 'root-2'
    await anon.sessionSwitch(ctx)
    expect(spawner.calls).toHaveLength(1)
    expect(spawner.calls[0]?.child.signals).toEqual([])
    expect(registry.getProviderBaseUrl('anthropic')).toBe('http://127.0.0.1:7123')
    expect(registry.getProviderHeaders('anthropic')?.[SESSION]).toBe('root-2')
  })
})

/** An `ImageSending` that records each `setBlocked` call and answers `result`. */
function fakeImages(result: boolean | 'throw' = true): ImageSending & { readonly calls: boolean[] } {
  const calls: boolean[] = []
  return {
    calls,
    async setBlocked(blocked) {
      calls.push(blocked)
      if (result === 'throw') throw new Error('settings store is read-only')
      return result
    },
  }
}

describe('image sending', () => {
  test('/anon on blocks images once and status says so; /anon off releases the block', async () => {
    const images = fakeImages()
    const anon = controller(ENV_PROXY, { images })
    const ctx = context(standardRegistry())
    await anon.command('on', ctx)
    await anon.command('on', ctx)
    expect(images.calls).toEqual([true])
    await anon.command('status', ctx)
    expect(lastNote(ctx)).toContain('\nimages: not sent (omp images.blockImages)\n')
    await anon.command('off', ctx)
    expect(images.calls).toEqual([true, false])
    await anon.command('status', ctx)
    expect(lastNote(ctx)).not.toContain('images:')
  })

  test('a failed /anon on leaves image sending alone', async () => {
    const images = fakeImages()
    const registry = standardRegistry()
    const anon = controller(ENV_PROXY, { images })
    await anon.command('on', context(registry, { active: registry.find('openai', 'openai-0'), setModelResult: false }))
    expect(images.calls).toEqual([])
  })

  test('a persisted flag blocks images at session start; required mode blocks them even when routing fails', async () => {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, '{"enabled":true}\n')
    const persistedOn = fakeImages()
    await controller(ENV_PROXY, { images: persistedOn }).sessionStart(context(standardRegistry()))
    expect(persistedOn.calls).toEqual([true])

    rmSync(statePath)
    const required = fakeImages()
    const ctx = context(standardRegistry())
    await controller({ SKAILE_TRANSFORM_PROXY_MODE: 'required' }, { images: required }).sessionStart(ctx)
    expect(ctx.statuses).toEqual(['🟠A'])
    expect(required.calls).toEqual([true])
  })

  test('a host without a way to block images warns once, is not asked again and nothing is released', async () => {
    const images = fakeImages(false)
    const anon = controller(ENV_PROXY, { images })
    const ctx = context(standardRegistry())
    await anon.command('on', ctx)
    await anon.command('status', ctx)
    await anon.command('off', ctx)
    await anon.command('on', ctx)
    expect(images.calls).toEqual([true])
    const warnings = ctx.notes.filter((note) => note.type === 'warning').map((note) => note.message)
    expect(warnings).toEqual(['anon: this omp cannot stop image sending; the proxy refuses every request that carries an image'])
  })

  test('a failing block warns with the cause and is retried by the next command; nothing is released', async () => {
    const images = fakeImages('throw')
    const anon = controller(ENV_PROXY, { images })
    const ctx = context(standardRegistry())
    await anon.command('on', ctx)
    expect(lastNote(ctx)).toBe('anon: could not stop image sending: settings store is read-only')
    await anon.command('status', ctx)
    await anon.command('off', ctx)
    expect(images.calls).toEqual([true, true])
  })
})

describe('ompImageSending', () => {
  /** omp's settings registry with one `images.blockImages` handle that records its writes per scope. */
  function fakeOmpRegistry(): { readonly module: unknown; readonly writes: string[]; readonly lookups: string[] } {
    const writes: string[] = []
    const lookups: string[] = []
    const handle = {
      override: (scope: { name: string }, value: unknown) => writes.push(`override ${scope.name} ${String(value)}`),
      clearOverride: (scope: { name: string }) => writes.push(`clear ${scope.name}`),
    }
    return {
      writes,
      lookups,
      module: {
        lookup: (id: string) => {
          lookups.push(id)
          return id === 'images.blockImages' ? handle : undefined
        },
      },
    }
  }

  function extensionApi(settings?: { name: string }): OmpExtensionApi {
    return {
      ...(settings === undefined ? {} : { pi: { settings } }),
      registerCommand: () => {},
      on: () => {},
      setModel: async () => true,
    }
  }

  test('overrides images.blockImages with true on the extension settings scope, then clears the override; the registry loads once', async () => {
    const omp = fakeOmpRegistry()
    let loads = 0
    const images = ompImageSending(extensionApi({ name: 'settings' }), async () => {
      loads++
      return omp.module
    })
    expect(await images.setBlocked(true)).toBe(true)
    expect(await images.setBlocked(false)).toBe(true)
    expect(omp.writes).toEqual(['override settings true', 'clear settings'])
    expect(omp.lookups).toEqual(['images.blockImages'])
    expect(loads).toBe(1)
  })

  test('answers false without a settings scope, a loadable registry or the setting', async () => {
    const omp = fakeOmpRegistry()
    expect(await ompImageSending(extensionApi(), async () => omp.module).setBlocked(true)).toBe(false)
    expect(omp.lookups).toEqual([])
    const unloadable = ompImageSending(extensionApi({ name: 'settings' }), () => Promise.reject(new Error('Cannot find module')))
    expect(await unloadable.setBlocked(true)).toBe(false)
    expect(await ompImageSending(extensionApi({ name: 'settings' }), async () => ({ lookup: () => undefined })).setBlocked(true)).toBe(false)
    expect(await ompImageSending(extensionApi({ name: 'settings' }), async () => ({})).setBlocked(true)).toBe(false)
  })
})

describe('proxy child process', () => {
  test('spawns node on the package CLI with the found config, port 0, loopback and stdin lifetime; a random token goes in its env and on every route', async () => {
    const path = writeConfig(root)
    const spawner = fakeSpawner((child) => {
      child.stdout.write('starting\nlisten')
      child.stdout.write('ing http://127.0.0.1:7123\n')
    })
    const anon = controller({ PATH: '/usr/bin', FOO: 'bar' }, { spawnChild: spawner.spawnChild, cliPath: CLI })
    const registry = standardRegistry()
    const ctx = context(registry)
    await anon.command('on', ctx)

    expect(spawner.calls).toHaveLength(1)
    const call = spawner.calls[0]!
    expect(call.command).toBe('node')
    expect(call.args).toEqual([CLI, '--config', path, '--port', '0', '--host', '127.0.0.1', '--exit-with-stdin'])
    expect(call.options.cwd).toBe(root)
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(call.options.env.PATH).toBe('/usr/bin')
    expect(call.options.env.FOO).toBe('bar')
    const token = call.options.env.SKAILE_TRANSFORM_PROXY_TOKEN
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    for (const provider of ['anthropic', 'openai', 'bedrock', 'vertex']) {
      expect(registry.getProviderBaseUrl(provider)).toBe('http://127.0.0.1:7123')
      expect(registry.getProviderHeaders(provider)?.[TOKEN]).toBe(token)
    }
    // Once listening, the child no longer holds omp's event loop, but its stdin pipe stays open.
    expect(call.child.unrefs).toBe(1)
    expect(call.child.stdin.writableEnded).toBe(false)
    expect(ctx.statuses).toEqual(['🟢A'])
    await anon.command('status', ctx)
    expect(lastNote(ctx)).toContain(`proxy: http://127.0.0.1:7123 (child process 4242, config ${path})`)
    expect(lastNote(ctx)).toContain('pipeline: plain')
    expect(lastNote(ctx)).not.toContain(token!)
  })

  test('SKAILE_TRANSFORM_PROXY_NODE names the node binary; each start draws a fresh token', async () => {
    writeConfig(root)
    const spawner = fakeSpawner()
    const env = { SKAILE_TRANSFORM_PROXY_NODE: '/opt/node22/bin/node' }
    await controller(env, { spawnChild: spawner.spawnChild, cliPath: CLI }).command('on', context(standardRegistry()))
    await controller(env, { spawnChild: spawner.spawnChild, cliPath: CLI }).command('on', context(standardRegistry()))
    expect(spawner.calls.map((call) => call.command)).toEqual(['/opt/node22/bin/node', '/opt/node22/bin/node'])
    const [first, second] = spawner.calls.map((call) => call.options.env.SKAILE_TRANSFORM_PROXY_TOKEN)
    expect(first).not.toBe(second)
  })

  test('one child serves every session and concurrent call', async () => {
    writeConfig(root)
    const spawner = fakeSpawner()
    const anon = controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI })
    const registry = standardRegistry()
    await Promise.all([anon.command('on', context(registry)), anon.command('on', context(registry))])
    await anon.sessionStart(context(registry, { sessionId: () => 'subagent' }))
    expect(spawner.calls).toHaveLength(1)
  })

  test('refuses on with a notice naming both lookup paths when no config exists', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const spawner = fakeSpawner()
    await controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI }).command('on', ctx)
    const home = join(root, 'home')
    expect(ctx.notes).toEqual([
      {
        message: `anon: no transform proxy config found: create ${join(root, '.skaile', 'transform-proxy.yaml')} or ${join(home, '.config', 'skaile', 'transform-proxy.yaml')}, or set SKAILE_TRANSFORM_PROXY_URL to a running proxy`,
        type: 'error',
      },
    ])
    expect(spawner.calls).toHaveLength(0)
    expect(registry.calls).toEqual([])
    expect(ctx.statuses).toEqual(['🔴A'])
    expect(existsSync(statePath)).toBe(false)
  })

  test('refuses a config without defaultPipeline before spawning: the extension sends no pipeline header', async () => {
    writeConfig(root, 'pipelines:\n  plain: []\n')
    const spawner = fakeSpawner()
    const ctx = context(standardRegistry())
    await controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI }).command('on', ctx)
    expect(lastNote(ctx)).toContain('sets no defaultPipeline')
    expect(spawner.calls).toHaveLength(0)
  })

  test('a child that exits before listening fails with its last stderr lines, the token redacted; nothing is routed', async () => {
    writeConfig(root)
    const spawner = fakeSpawner((child, call) => {
      for (let line = 1; line <= 12; line++) child.stderr.write(`stderr line ${line}\n`)
      child.stderr.write(`token was ${call.options.env.SKAILE_TRANSFORM_PROXY_TOKEN}\n`)
      child.exit(1)
    })
    const registry = standardRegistry()
    const ctx = context(registry)
    await controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI }).command('on', ctx)
    const token = spawner.calls[0]!.options.env.SKAILE_TRANSFORM_PROXY_TOKEN!
    const note = ctx.notes[0]!
    expect(note.type).toBe('error')
    expect(note.message).toStartWith('anon: the transform proxy child process (node, pid 4242) exited with code 1 before it was listening; last stderr lines:\n')
    expect(note.message).toContain('stderr line 12\ntoken was [token]')
    expect(note.message).not.toContain('stderr line 3\n')
    expect(note.message).not.toContain(token)
    expect(registry.calls).toEqual([])
    expect(ctx.statuses).toEqual(['🔴A'])
    expect(existsSync(statePath)).toBe(false)
  })

  test('a child that never prints listening is killed at the timeout; the error names the timeout and its stderr', async () => {
    writeConfig(root)
    const spawner = fakeSpawner((child) => child.stderr.write('loading model\n'))
    const anon = controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI, listenTimeoutMs: 45_000 })
    const ctx = context(standardRegistry())
    vi.useFakeTimers()
    try {
      const pending = anon.command('on', ctx)
      const child = spawner.calls[0]!.child
      await once(child.stderr, 'data')
      vi.advanceTimersByTime(45_000)
      await pending
      expect(child.signals).toEqual(['SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
    expect(lastNote(ctx)).toBe('anon: the transform proxy child process (node, pid 4242) did not print "listening" within 45 s and was killed; last stderr lines:\nloading model')
    expect(ctx.statuses).toEqual(['🔴A'])
  })

  test('a spawn error (node missing) says that the proxy needs Node on PATH or SKAILE_TRANSFORM_PROXY_NODE', async () => {
    writeConfig(root)
    const spawner = fakeSpawner((child) => child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })))
    const ctx = context(standardRegistry())
    await controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI }).command('on', ctx)
    expect(lastNote(ctx)).toBe(
      'anon: could not start the transform proxy with "node": spawn node ENOENT; it runs under Node >= 22: put node on PATH or set SKAILE_TRANSFORM_PROXY_NODE',
    )
    expect(ctx.statuses).toEqual(['🔴A'])
  })

  test('a failed start is retried on the next on', async () => {
    writeConfig(root)
    const spawner = fakeSpawner((child) => (spawner.calls.length === 1 ? child.exit(1) : child.listen()))
    const anon = controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI })
    const ctx = context(standardRegistry())
    await anon.command('on', ctx)
    expect(lastNote(ctx)).toContain('exited with code 1 before it was listening; last stderr lines:\n(none)')
    await anon.command('on', ctx)
    expect(spawner.calls).toHaveLength(2)
    expect(ctx.statuses).toEqual(['🔴A', '🟢A'])
  })

  test('omp exiting kills the child; the exit hook goes away with the child', async () => {
    writeConfig(root)
    const spawner = fakeSpawner()
    const before = new Set(process.listeners('exit'))
    await controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI }).command('on', context(standardRegistry()))
    const added = process.listeners('exit').filter((listener) => !before.has(listener))
    expect(added).toHaveLength(1)
    added[0]!(0)
    expect(spawner.calls[0]!.child.signals).toEqual(['SIGTERM'])
    expect(process.listeners('exit').filter((listener) => !before.has(listener))).toEqual([])
  })

  test('a child that dies after listening is forgotten: the next turn starts a new one and re-routes to it', async () => {
    writeConfig(root)
    const spawner = fakeSpawner((child) => child.listen(`http://127.0.0.1:${7100 + spawner.calls.length}`))
    const anon = controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI })
    const registry = standardRegistry()
    const ctx = context(registry)
    await anon.command('on', ctx)
    expect(registry.getProviderBaseUrl('openai')).toBe('http://127.0.0.1:7101')
    spawner.calls[0]!.child.exit(null, 'SIGKILL')
    await anon.reapply(ctx)
    expect(spawner.calls).toHaveLength(2)
    expect(registry.getProviderBaseUrl('openai')).toBe('http://127.0.0.1:7102')
    expect(registry.getProviderHeaders('openai')?.[TOKEN]).toBe(spawner.calls[1]!.options.env.SKAILE_TRANSFORM_PROXY_TOKEN)
  })

  /** A stderr line as the proxy CLI prints its leak warning. */
  function leakLine(sessionId: string, leaks: readonly Record<string, string>[], route = 'anthropic.messages'): string {
    return `[transform-proxy warn] transform proxy: known original sent upstream ${JSON.stringify({ sessionId, route, leaks })}\n`
  }

  /** Writes `text` to the child's stderr and waits until the controller's handler (registered first) has seen it. */
  async function writeStderr(child: FakeChild, text: string): Promise<void> {
    const seen = once(child.stderr, 'data')
    child.stderr.write(text)
    await seen
  }

  function warnings(ctx: FakeContext): string[] {
    return ctx.notes.filter((note) => note.type === 'warning').map((note) => note.message)
  }

  test('leak warnings on stderr after listening become one warning per session and kind, without the value', async () => {
    writeConfig(root)
    const spawner = fakeSpawner()
    const anon = controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI })
    const ctx = context(standardRegistry())
    await anon.command('on', ctx)
    const child = spawner.calls[0]!.child
    // Startup unrefs the child and every pipe, so reading stderr afterwards does not hold omp's event loop.
    expect(child.unrefs).toBe(1)

    // The `value` field is hostile input: the proxy never prints one, and the notice must not repeat it.
    const person = { kind: 'person', source: 'crm', at: 'tools[0].description', value: 'Alice Smith' }
    const line = leakLine('s1', [person, { kind: 'person', source: 'crm', at: 'system' }])
    await writeStderr(child, line + line.slice(0, 20))
    await writeStderr(child, `${line.slice(20)}${leakLine('s1', [{ kind: 'email', source: 'crm', at: 'messages[3].content[0].text' }], 'openai.chat')}`)

    expect(warnings(ctx)).toEqual([
      'anon: a known person value was sent to the provider in clear text (at tools[0].description, route anthropic.messages). Value not shown.',
      'anon: a known email value was sent to the provider in clear text (at messages[3].content[0].text, route openai.chat). Value not shown.',
    ])
    expect(JSON.stringify(ctx.notes)).not.toContain('Alice')

    // Another session is noticed on its own.
    await writeStderr(child, leakLine('s2', [{ kind: 'person', source: 'crm', at: 'system' }]))
    expect(warnings(ctx)).toHaveLength(3)
  })

  test('malformed leak lines and other stderr output notify nothing', async () => {
    writeConfig(root)
    const spawner = fakeSpawner()
    const anon = controller({}, { spawnChild: spawner.spawnChild, cliPath: CLI })
    const ctx = context(standardRegistry())
    await anon.command('on', ctx)
    const child = spawner.calls[0]!.child
    const marker = '[transform-proxy warn] transform proxy: known original sent upstream'
    await writeStderr(
      child,
      [
        `${marker} {not json`,
        `${marker} {"sessionId":"s1","route":"anthropic.messages"}`,
        `${marker} {"sessionId":"s1","route":"anthropic.messages","leaks":[{"kind":7,"at":"system"}]}`,
        `${marker} {"sessionId":"s1","route":"anthropic.messages","leaks":[]}`,
        `${marker}`,
        '[transform-proxy info] listening elsewhere',
        '',
      ].join('\n'),
    )
    expect(warnings(ctx)).toEqual([])
  })
})

describe('proxy child process under node', () => {
  const node = Bun.which('node')

  test.skipIf(node === null)('the extension spawns the built CLI: it listens, refuses requests without the token and exits when its stdin closes', async () => {
    const out = join(root, 'dist')
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL('../src/cli.ts', import.meta.url))],
      outdir: out,
      target: 'node',
      format: 'esm',
      naming: '[name].mjs',
    })
    expect(build.success).toBe(true)
    writeConfig(root)
    const spawned: ChildProcess[] = []
    const anon = controller({ PATH: process.env.PATH }, {
      cliPath: join(out, 'cli.mjs'),
      spawnChild: (command, args, options) => {
        const child = spawn(command, [...args], { ...options, stdio: [...options.stdio] })
        spawned.push(child)
        children.push(child)
        return child
      },
    })
    const registry = standardRegistry()
    const ctx = context(registry)
    await anon.command('on', ctx)
    expect(ctx.statuses).toEqual(['🟢A'])
    const url = registry.getProviderBaseUrl('anthropic')!
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const token = registry.getProviderHeaders('anthropic')![TOKEN]!

    const missing = await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' })
    expect(missing.status).toBe(401)
    const withToken = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { [TOKEN]: token }, body: '{}' })
    expect(withToken.status).toBe(400)

    const child = spawned[0]!
    const exited = once(child, 'exit')
    child.stdin!.end()
    expect(await exited).toEqual([0, null])
  }, 30_000)
})

describe('extension registration', () => {
  interface Registered {
    readonly commands: Map<string, Parameters<OmpExtensionApi['registerCommand']>[1]>
    readonly events: Map<OmpEventName, (event: unknown, ctx: OmpContext) => unknown>
    readonly rebinds: OmpModel[]
    readonly pi: OmpExtensionApi
  }

  function fakePi(): Registered {
    const commands: Registered['commands'] = new Map()
    const events: Registered['events'] = new Map()
    const rebinds: OmpModel[] = []
    return {
      commands,
      events,
      rebinds,
      pi: {
        registerCommand: (name, options) => commands.set(name, options),
        on: (event, handler) => events.set(event, handler),
        setModel: async (model) => (rebinds.push(model), true),
      },
    }
  }

  test('registers /anon with completions and the session, turn and provider-request handlers', async () => {
    const { pi, commands, events, rebinds } = fakePi()
    registerAnonExtension(pi, controller().inner)
    expect([...commands.keys()]).toEqual(['anon'])
    expect([...events.keys()]).toEqual(['session_start', 'session_switch', 'before_agent_start', 'turn_start', 'before_provider_request'])
    expect(commands.get('anon')?.getArgumentCompletions?.('of')?.map((item) => item.value)).toEqual(['off', 'off --global'])

    const registry = standardRegistry()
    const ctx = context(registry, { active: registry.find('openai', 'openai-0') })
    await commands.get('anon')?.handler('on', ctx)
    // The extension API's setModel rebinds the session model.
    expect(rebinds.map((model) => model.baseUrl)).toEqual(['http://127.0.0.1:7001'])
    registry.runtime.delete('openai')
    await events.get('turn_start')?.({ type: 'turn_start' }, ctx)
    expect(registry.getProviderBaseUrl('openai')).toBe('http://127.0.0.1:7001')
  })

  test('a throwing handler becomes an error notice instead of an omp error', async () => {
    const { pi, commands } = fakePi()
    registerAnonExtension(pi, controller().inner)
    const registry = standardRegistry()
    registry.registerProvider = () => {
      throw new Error('registry exploded')
    }
    const ctx = context(registry)
    await commands.get('anon')?.handler('on', ctx)
    expect(ctx.notes.at(-1)).toEqual({ message: 'anon: registry exploded', type: 'error' })
  })

  test('the default export shares one process-wide controller across extension instances', async () => {
    const key = Symbol.for('@skaile/transform-proxy/omp')
    const scope = globalThis as Record<symbol, unknown>
    const previous = { url: process.env.SKAILE_TRANSFORM_PROXY_URL, state: process.env.SKAILE_TRANSFORM_PROXY_OMP_STATE }
    process.env.SKAILE_TRANSFORM_PROXY_URL = 'http://127.0.0.1:7002'
    process.env.SKAILE_TRANSFORM_PROXY_OMP_STATE = statePath
    delete scope[key]
    try {
      const parent = fakePi()
      const subagent = fakePi()
      anonExtension(parent.pi)
      anonExtension(subagent.pi)
      const registry = standardRegistry()
      const ctx = context(registry)
      await parent.commands.get('anon')?.handler('on', ctx)
      await subagent.commands.get('anon')?.handler('status', ctx)
      expect(lastNote(ctx)).toStartWith('anon on\nproxy: http://127.0.0.1:7002')
    } finally {
      delete scope[key]
      restoreEnv('SKAILE_TRANSFORM_PROXY_URL', previous.url)
      restoreEnv('SKAILE_TRANSFORM_PROXY_OMP_STATE', previous.state)
    }
  })
})

describe('defaultStatePath', () => {
  test('prefers the env override, then PI_CODING_AGENT_DIR, then ~/.omp/agent', () => {
    expect(defaultStatePath({ SKAILE_TRANSFORM_PROXY_OMP_STATE: '/x/state.json' }, '/home/u')).toBe('/x/state.json')
    expect(defaultStatePath({ PI_CODING_AGENT_DIR: '/agent' }, '/home/u')).toBe('/agent/skaile-transform-proxy.json')
    expect(defaultStatePath({}, '/home/u')).toBe('/home/u/.omp/agent/skaile-transform-proxy.json')
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
