import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import anonExtension, { createAnonController, defaultStatePath, registerAnonExtension } from '../src/omp/index.ts'
import type { AnonController, AnonControllerDeps } from '../src/omp/index.ts'
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
import { createTransformProxy, type TransformProxy, type TransformProxyOptions } from '../src/server.ts'

const UPSTREAM = 'x-skaile-transform-upstream'
const SESSION = 'x-skaile-transform-session'
const TOKEN = 'x-skaile-transform-token'

let root: string
let statePath: string
const started: TransformProxy[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stp-omp-'))
  statePath = join(root, 'agent', 'skaile-transform-proxy.json')
})

afterEach(async () => {
  await Promise.all(started.splice(0).map((proxy) => proxy.close()))
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

describe('/anon command parsing', () => {
  test('completes the three verbs by prefix', () => {
    const anon = controller()
    expect(anon.completions('')?.map((item) => item.value)).toEqual(['on', 'off', 'status'])
    expect(anon.completions('o')?.map((item) => item.value)).toEqual(['on', 'off'])
    expect(anon.completions(' ST')?.map((item) => item.value)).toEqual(['status'])
    expect(anon.completions('x')).toBeNull()
  })

  test('an unknown verb notifies the usage and changes nothing', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    await controller().command('maybe', ctx)
    expect(ctx.notes).toEqual([{ message: 'usage: /anon on|off|status', type: 'error' }])
    expect(registry.calls).toEqual([])
    expect(ctx.statuses).toEqual(['anon off'])
  })

  test('verbs are trimmed and case-insensitive; an empty argument shows the status', async () => {
    const ctx = context(standardRegistry())
    const anon = controller()
    await anon.command('  ON ', ctx)
    expect(ctx.statuses.at(-1)).toBe('anon on')
    await anon.command('', ctx)
    expect(lastNote(ctx)).toStartWith('anon on')
  })
})

describe('/anon on with SKAILE_TRANSFORM_PROXY_URL', () => {
  test('routes every provider through the env proxy with upstream, session and token headers', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    let starts = 0
    await controller(ENV_PROXY, { startProxy: async () => (starts++, Promise.reject(new Error('unused'))) }).command('on', ctx)

    expect(starts).toBe(0)
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
    expect(ctx.statuses).toEqual(['anon on'])
    expect(lastNote(ctx)).toBe('anon on: 4 provider(s) routed through http://127.0.0.1:7001')
    expect(persisted()).toEqual({ enabled: true })
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
      expect(ctx.statuses).toEqual(['anon off'])
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
    expect(ctx.statuses).toEqual(['anon error'])
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
    expect(broken.statuses).toEqual(['anon error'])
    expect(broken.notes.map((note) => note.type)).toEqual(['error', 'error'])
    expect(registry.getProviderBaseUrl('anthropic')).toBe('https://api.anthropic.com')
    expect(anon.providerRequest(requestContext(broken, stale))).toEqual({})
    const healthy = context(registry, { active: stale })
    await anon.reapply(healthy)
    expect(healthy.statuses).toEqual(['anon on'])
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
  test('clears the proxy source in one call, which drops the proxy headers, and persists the flag', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const anon = controller()
    await anon.command('on', ctx)
    await anon.command('off', ctx)
    expect(registry.calls.filter((call) => !call.startsWith('register'))).toEqual(['clear skaile-transform-proxy'])
    expect(registry.getProviderBaseUrl('anthropic')).toBe('https://api.anthropic.com')
    expect(registry.getProviderHeaders('anthropic')).toEqual({ 'x-team': 'a' })
    expect(registry.getProviderHeaders('openai')).toBeUndefined()
    expect(ctx.statuses).toEqual(['anon on', 'anon off'])
    expect(lastNote(ctx)).toBe('anon off: original provider base URLs restored')
    expect(persisted()).toEqual({ enabled: false })
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
    expect(ctx.statuses.at(-1)).toBe('anon on')
    expect(persisted()).toEqual({ enabled: true })
  })
})

describe('/anon status', () => {
  test('lists state, proxy, pipeline, session, routed and refused providers', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const anon = controller()
    await anon.command('status', ctx)
    expect(lastNote(ctx)).toBe('anon off\nrouted (0): none')
    await anon.command('on', ctx)
    await anon.command('status', ctx)
    expect(lastNote(ctx)).toBe(
      [
        'anon on',
        'proxy: http://127.0.0.1:7001 (SKAILE_TRANSFORM_PROXY_URL)',
        'pipeline: the proxy default',
        'session: omp-session-1',
        'routed (4): anthropic, bedrock, openai, vertex',
        'refused by the proxy (2): bedrock (bedrock-converse-stream), vertex (no base URL)',
      ].join('\n'),
    )
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
    expect(ctx.statuses).toEqual(['anon on'])
  })

  test('stays off without a flag, or with a corrupt one, and shows the off status', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    await controller().sessionStart(ctx)
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, '{not json')
    await controller().sessionStart(ctx)
    expect(registry.calls).toEqual([])
    expect(ctx.statuses).toEqual(['anon off', 'anon off'])
  })

  test('required mode forces routing on even when the flag says off', async () => {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify({ enabled: false }))
    const registry = standardRegistry()
    const ctx = context(registry)
    await controller({ ...ENV_PROXY, SKAILE_TRANSFORM_PROXY_MODE: 'required' }).sessionStart(ctx)
    expect(registry.getProviderBaseUrl('openai')).toBe('http://127.0.0.1:7001')
    expect(ctx.statuses).toEqual(['anon on'])
  })

  test('required mode without a reachable proxy shows anon error and refuses model requests', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const anon = controller({ SKAILE_TRANSFORM_PROXY_MODE: 'required' })
    await anon.sessionStart(ctx)
    expect(ctx.notes.map((note) => note.type)).toEqual(['error', 'error'])
    expect(ctx.notes[1]?.message).toBe('anon: required mode: model requests are refused until the transform proxy is routed (SKAILE_TRANSFORM_PROXY_MODE=required)')
    expect(ctx.statuses).toEqual(['anon error'])
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
    expect(ctx.statuses.at(-1)).toBe('anon on')
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

  test('the in-process proxy drops the rotated-out session', async () => {
    mkdirSync(join(root, '.skaile'), { recursive: true })
    writeFileSync(join(root, '.skaile', 'transform-proxy.yaml'), 'pipelines:\n  plain: []\ndefaultPipeline: plain\n')
    const dropped: string[] = []
    const anon = controller({}, {
      startProxy: async (options) => {
        const proxy = await createTransformProxy(options)
        started.push(proxy)
        return { ...proxy, url: proxy.url, dropSession: async (sessionId: string) => {
          dropped.push(sessionId)
        } }
      },
    })
    let id = 'root-1'
    const registry = standardRegistry()
    const ctx = context(registry, { sessionId: () => id, hasUI: true, mode: 'tui' })
    await anon.command('on', ctx)
    await anon.sessionSwitch(ctx)
    expect(dropped).toEqual([])
    id = 'root-2'
    await anon.sessionSwitch(ctx)
    expect(dropped).toEqual(['root-1'])
    expect(registry.getProviderHeaders('anthropic')?.[SESSION]).toBe('root-2')
  })
})

describe('in-process proxy', () => {
  const CONFIG = 'pipelines:\n  plain: []\ndefaultPipeline: plain\n'

  function writeConfig(dir: string, body = CONFIG): void {
    mkdirSync(join(dir, '.skaile'), { recursive: true })
    writeFileSync(join(dir, '.skaile', 'transform-proxy.yaml'), body)
  }

  function realStarter(): { starts: () => number; startProxy: (options: TransformProxyOptions) => Promise<TransformProxy> } {
    let count = 0
    return {
      starts: () => count,
      startProxy: async (options) => {
        count++
        const proxy = await createTransformProxy(options)
        started.push(proxy)
        return proxy
      },
    }
  }

  test('starts one proxy from the config lookup and shares it across sessions and concurrent calls', async () => {
    writeConfig(root)
    const starter = realStarter()
    const anon = controller({}, { startProxy: starter.startProxy })
    const registry = standardRegistry()
    const first = context(registry)
    await Promise.all([anon.command('on', first), anon.command('on', context(registry))])
    await anon.sessionStart(context(registry, { sessionId: () => 'subagent' }))
    expect(starter.starts()).toBe(1)
    const url = registry.getProviderBaseUrl('anthropic')
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(registry.getProviderHeaders('anthropic')?.[TOKEN]).toBeUndefined()
    await anon.command('status', first)
    expect(lastNote(first)).toContain(`proxy: ${url} (in-process, config ${join(root, '.skaile', 'transform-proxy.yaml')})`)
    expect(lastNote(first)).toContain('pipeline: plain')
    // The proxy answers: a GET .../models is relayed to the (loopback, unreachable) upstream and fails as 502, not 404.
    const response = await fetch(`${url}/v1/models`, { headers: { [UPSTREAM]: 'http://127.0.0.1:9' } })
    expect(response.status).not.toBe(404)
  })

  test('refuses on with a notice naming both lookup paths when no config exists', async () => {
    const registry = standardRegistry()
    const ctx = context(registry)
    const starter = realStarter()
    await controller({}, { startProxy: starter.startProxy }).command('on', ctx)
    const home = join(root, 'home')
    expect(ctx.notes).toEqual([
      {
        message: `anon: no transform proxy config found: create ${join(root, '.skaile', 'transform-proxy.yaml')} or ${join(home, '.config', 'skaile', 'transform-proxy.yaml')}, or set SKAILE_TRANSFORM_PROXY_URL to a running proxy`,
        type: 'error',
      },
    ])
    expect(starter.starts()).toBe(0)
    expect(registry.calls).toEqual([])
    expect(ctx.statuses).toEqual(['anon off'])
    expect(existsSync(statePath)).toBe(false)
  })

  test('refuses a config without defaultPipeline: the extension sends no pipeline header', async () => {
    writeConfig(root, 'pipelines:\n  plain: []\n')
    const ctx = context(standardRegistry())
    await controller({}).command('on', ctx)
    expect(lastNote(ctx)).toContain('sets no defaultPipeline')
  })

  test('a failed start is retried on the next on', async () => {
    writeConfig(root)
    let calls = 0
    const anon = controller({}, {
      startProxy: async (options) => {
        calls++
        if (calls === 1) throw new Error('port busy')
        const proxy = await createTransformProxy(options)
        started.push(proxy)
        return proxy
      },
    })
    const registry = standardRegistry()
    const ctx = context(registry)
    await anon.command('on', ctx)
    expect(lastNote(ctx)).toBe('anon: port busy')
    await anon.command('on', ctx)
    expect(calls).toBe(2)
    expect(ctx.statuses).toEqual(['anon off', 'anon on'])
  })
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
    expect(commands.get('anon')?.getArgumentCompletions?.('of')?.map((item) => item.value)).toEqual(['off'])

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
