import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configCandidates, findProxyConfig, loadProxyConfig } from '../config.ts'
import { errorMessage, silentLogger } from '../log.ts'
import {
  createTransformProxy,
  SESSION_HEADER,
  TOKEN_HEADER,
  UPSTREAM_HEADER,
  type TransformProxy,
  type TransformProxyOptions,
} from '../server.ts'
import type { OmpAutocompleteItem, OmpContext, OmpModelRegistry, OmpSessionActions } from './types.ts'

/** A running proxy the extension routes to. */
export const URL_ENV = 'SKAILE_TRANSFORM_PROXY_URL'
/** The client token of that proxy. */
export const TOKEN_ENV = 'SKAILE_TRANSFORM_PROXY_TOKEN'
/** `required` (set by a skaile session in required mode): routing is forced on and `/anon off` is refused. */
export const MODE_ENV = 'SKAILE_TRANSFORM_PROXY_MODE'
/** Overrides the path of the persisted enabled flag. */
export const STATE_ENV = 'SKAILE_TRANSFORM_PROXY_OMP_STATE'
/** The footer status key. */
export const STATUS_KEY = 'anon'
/** The model-registry source the proxy overrides are registered under; `/anon off` clears it in one reload. */
export const SOURCE_ID = 'skaile-transform-proxy'
/** The wire APIs the proxy rewrites. Providers on any other API are routed too, and the proxy refuses their requests. */
export const SERVED_APIS: Readonly<Record<string, true>> = {
  'anthropic-messages': true,
  'openai-completions': true,
  'openai-responses': true,
}

const USAGE = 'usage: /anon on|off|status'
const VERBS: readonly OmpAutocompleteItem[] = [
  { value: 'on', label: 'on', description: 'route every provider through the transform proxy' },
  { value: 'off', label: 'off', description: 'restore the original provider base URLs' },
  { value: 'status', label: 'status', description: 'show the proxy, pipeline and routed providers' },
]

export interface AnonControllerDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  /** Default: `$SKAILE_TRANSFORM_PROXY_OMP_STATE`, else `<omp agent dir>/skaile-transform-proxy.json`. */
  readonly statePath?: string
  /** Default: `createTransformProxy`. */
  readonly startProxy?: (options: TransformProxyOptions) => Promise<TransformProxy>
}

export interface AnonController {
  readonly required: boolean
  readonly statePath: string
  /** Handles `/anon <args>`. `session` rebinds the session's active model after a switch. */
  command(args: string, ctx: OmpContext, session: OmpSessionActions): Promise<void>
  completions(prefix: string): OmpAutocompleteItem[] | null
  /** Applies the persisted flag (or required mode) and refreshes the status bar. */
  sessionStart(ctx: OmpContext, session: OmpSessionActions): Promise<void>
  /** While on: routes providers that appeared, or were reset, since the last pass. */
  reapply(ctx: OmpContext, session: OmpSessionActions): Promise<void>
}

interface Endpoint {
  readonly url: string
  readonly token?: string
  /** The pipeline the proxy applies; `undefined` = the proxy's default (unknown here). */
  readonly pipeline?: string
  readonly source: string
}

interface Original {
  readonly baseUrl?: string
  readonly headers?: Record<string, string>
  /** The provider's own config already points it at a transform proxy; it is never re-registered. */
  readonly preRouted: boolean
}

interface RegistryState {
  /** Recorded on first sight, never overwritten: the values `/anon off` restores. */
  readonly originals: Map<string, Original>
  readonly routed: Set<string>
}

/**
 * The process-wide `/anon` state machine. omp builds one extension instance per session
 * (subagents included) while they share one model registry, so one controller serves them all.
 */
export function createAnonController(deps: AnonControllerDeps): AnonController {
  const env = deps.env
  const required = env[MODE_ENV] === 'required'
  const statePath = deps.statePath ?? defaultStatePath(env, deps.home)
  const startProxy = deps.startProxy ?? createTransformProxy
  const registries = new WeakMap<OmpModelRegistry, RegistryState>()
  let enabled = false
  let endpoint: Endpoint | undefined
  let starting: Promise<Endpoint> | undefined
  let sessionId: string | undefined

  function stateOf(registry: OmpModelRegistry): RegistryState {
    let state = registries.get(registry)
    if (state === undefined) {
      state = { originals: new Map(), routed: new Set() }
      registries.set(registry, state)
    }
    return state
  }

  async function resolveEndpoint(ctx: OmpContext): Promise<Endpoint> {
    if (endpoint !== undefined) return endpoint
    const url = env[URL_ENV]
    if (url !== undefined && url !== '') {
      const token = env[TOKEN_ENV]
      endpoint = { url, ...(token ? { token } : {}), source: URL_ENV }
      return endpoint
    }
    starting ??= startInProcess(ctx.cwd).finally(() => {
      starting = undefined
    })
    endpoint = await starting
    return endpoint
  }

  async function startInProcess(cwd: string): Promise<Endpoint> {
    const path = findProxyConfig({ cwd, home: deps.home })
    if (path === undefined) {
      const searched = configCandidates(cwd, deps.home).join(' or ')
      throw new Error(`no transform proxy config found: create ${searched}, or set ${URL_ENV} to a running proxy`)
    }
    const options = loadProxyConfig(path)
    if (options.defaultPipeline === undefined) {
      throw new Error(`${path} sets no defaultPipeline: the omp extension sends no pipeline header`)
    }
    const proxy = await startProxy({ ...options, log: silentLogger })
    return { url: proxy.url, pipeline: options.defaultPipeline, source: `in-process, config ${path}` }
  }

  function currentSessionId(ctx: OmpContext): string {
    if (sessionId === undefined) {
      let id: unknown
      try {
        id = ctx.sessionManager.getSessionId()
      } catch {
        id = undefined
      }
      sessionId = typeof id === 'string' && id !== '' ? id : randomUUID()
    }
    return sessionId
  }

  function route(ctx: OmpContext, target: Endpoint): void {
    const registry = ctx.modelRegistry
    const state = stateOf(registry)
    const session = currentSessionId(ctx)
    for (const provider of providerApis(registry).keys()) {
      let original = state.originals.get(provider)
      if (original === undefined) {
        original = snapshot(registry, provider)
        state.originals.set(provider, original)
      }
      if (original.preRouted) continue
      if (state.routed.has(provider) && registry.getProviderBaseUrl(provider) === target.url) continue
      // omp merges these into the provider's existing headers, so its own headers stay in place.
      const headers: Record<string, string> = { [SESSION_HEADER]: session }
      if (original.baseUrl !== undefined) headers[UPSTREAM_HEADER] = original.baseUrl
      if (target.token !== undefined) headers[TOKEN_HEADER] = target.token
      registry.registerProvider(provider, { baseUrl: target.url, headers }, SOURCE_ID)
      state.routed.add(provider)
    }
  }

  /** Clears the proxy overrides; re-applies the recorded original where another override was layered underneath. */
  function unroute(ctx: OmpContext): string[] {
    const registry = ctx.modelRegistry
    const state = stateOf(registry)
    // A re-registration would merge, not remove, the proxy headers: only clearing the source drops them.
    registry.clearSourceRegistrations(SOURCE_ID)
    const lost: string[] = []
    for (const provider of state.routed) {
      const original = state.originals.get(provider)
      const restored = registry.getProviderBaseUrl(provider)
      if (original === undefined || restored === original.baseUrl) continue
      if (restored === undefined) {
        lost.push(provider)
        continue
      }
      if (original.baseUrl !== undefined) {
        registry.registerProvider(provider, {
          baseUrl: original.baseUrl,
          ...(original.headers === undefined ? {} : { headers: original.headers }),
        })
      }
    }
    state.routed.clear()
    return lost
  }

  async function turnOn(ctx: OmpContext, session: OmpSessionActions): Promise<boolean> {
    let target: Endpoint
    try {
      target = await resolveEndpoint(ctx)
    } catch (err) {
      ctx.ui.notify(`anon: ${errorMessage(err)}`, 'error')
      return false
    }
    route(ctx, target)
    enabled = true
    await rebind(ctx, session)
    return true
  }

  /** The session holds its active model as a snapshot: swap in the registry's re-projected one. */
  async function rebind(ctx: OmpContext, session: OmpSessionActions): Promise<void> {
    const active = ctx.model
    if (active === undefined) return
    const live = ctx.modelRegistry.find(active.provider, active.id)
    if (live === undefined || live.baseUrl === active.baseUrl) return
    if (!(await session.setModel(live))) {
      ctx.ui.notify(`anon: could not rebind the active model ${active.provider}/${active.id}; select it again`, 'warning')
    }
  }

  function persist(ctx: OmpContext, value: boolean): void {
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, `${JSON.stringify({ enabled: value }, null, 2)}\n`)
    } catch (err) {
      ctx.ui.notify(`anon: could not save ${statePath}: ${errorMessage(err)}`, 'warning')
    }
  }

  function showStatus(ctx: OmpContext): void {
    ctx.ui.setStatus(STATUS_KEY, enabled ? 'anon on' : 'anon off')
  }

  function statusText(ctx: OmpContext): string {
    const registry = ctx.modelRegistry
    const state = stateOf(registry)
    const apis = providerApis(registry)
    const lines = [`anon ${enabled ? 'on' : 'off'}${required ? ' (required)' : ''}`]
    if (endpoint !== undefined) {
      lines.push(`proxy: ${endpoint.url} (${endpoint.source})`)
      lines.push(`pipeline: ${endpoint.pipeline ?? 'the proxy default'}`)
    }
    if (sessionId !== undefined) lines.push(`session: ${sessionId}`)
    const routed = [...state.routed].sort()
    const refused = routed.flatMap((provider) => {
      const reason = refusalReason(apis.get(provider), state.originals.get(provider))
      return reason === undefined ? [] : [`${provider} (${reason})`]
    })
    const preRouted = [...state.originals].filter(([, original]) => original.preRouted).map(([provider]) => provider)
    lines.push(`routed (${routed.length}): ${routed.length === 0 ? 'none' : routed.join(', ')}`)
    if (refused.length > 0) lines.push(`refused by the proxy (${refused.length}): ${refused.join(', ')}`)
    if (preRouted.length > 0) lines.push(`routed by their own config (${preRouted.length}): ${preRouted.sort().join(', ')}`)
    return lines.join('\n')
  }

  return {
    required,
    statePath,

    async command(args, ctx, session) {
      const verb = args.trim().toLowerCase()
      switch (verb) {
        case 'on': {
          if (await turnOn(ctx, session)) {
            persist(ctx, true)
            const count = stateOf(ctx.modelRegistry).routed.size
            ctx.ui.notify(`anon on: ${count} provider(s) routed through ${endpoint?.url}`, 'info')
          }
          break
        }
        case 'off': {
          if (required) {
            ctx.ui.notify(`anon: off refused: this session requires the transform proxy (${MODE_ENV}=required)`, 'warning')
            break
          }
          const lost = unroute(ctx)
          enabled = false
          await rebind(ctx, session)
          persist(ctx, false)
          ctx.ui.notify('anon off: original provider base URLs restored', 'info')
          if (lost.length > 0) {
            ctx.ui.notify(
              `anon: ${lost.join(', ')} lost their runtime registration (registered by another extension); restart omp to restore them`,
              'warning',
            )
          }
          break
        }
        case '':
        case 'status':
          ctx.ui.notify(statusText(ctx), 'info')
          break
        default:
          ctx.ui.notify(USAGE, 'error')
      }
      showStatus(ctx)
    },

    completions(prefix) {
      const needle = prefix.trim().toLowerCase()
      const items = VERBS.filter((item) => item.value.startsWith(needle))
      return items.length > 0 ? items : null
    },

    async sessionStart(ctx, session) {
      currentSessionId(ctx)
      if (enabled && endpoint !== undefined) {
        route(ctx, endpoint)
        await rebind(ctx, session)
      } else if (required || readEnabled(statePath)) {
        const on = await turnOn(ctx, session)
        if (!on && required) ctx.ui.notify('anon: required mode, but no provider is routed through the transform proxy', 'error')
      }
      showStatus(ctx)
    },

    async reapply(ctx, session) {
      if (!enabled || endpoint === undefined) return
      route(ctx, endpoint)
      await rebind(ctx, session)
    },
  }
}

/** `$SKAILE_TRANSFORM_PROXY_OMP_STATE`, else `skaile-transform-proxy.json` in omp's agent dir (`$PI_CODING_AGENT_DIR` or `~/.omp/agent`). */
export function defaultStatePath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const explicit = env[STATE_ENV]
  if (explicit !== undefined && explicit !== '') return explicit
  const agentDir = env.PI_CODING_AGENT_DIR || join(home, '.omp', 'agent')
  return join(agentDir, 'skaile-transform-proxy.json')
}

function readEnabled(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && 'enabled' in parsed && parsed.enabled === true
  } catch {
    return false
  }
}

/** Every provider of the registry with the wire APIs of its models. */
function providerApis(registry: OmpModelRegistry): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const model of registry.getAll()) {
    let apis = out.get(model.provider)
    if (apis === undefined) {
      apis = new Set()
      out.set(model.provider, apis)
    }
    apis.add(model.api)
  }
  return out
}

function snapshot(registry: OmpModelRegistry, provider: string): Original {
  const live = registry.getProviderHeaders(provider)
  // omp hands out a live view; copy it so later overrides do not show through.
  const headers = live === undefined ? undefined : { ...live }
  const preRouted = headers !== undefined && Object.keys(headers).some((name) => name.toLowerCase() === UPSTREAM_HEADER)
  const baseUrl = registry.getProviderBaseUrl(provider)
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(headers === undefined || Object.keys(headers).length === 0 ? {} : { headers }),
    preRouted,
  }
}

function refusalReason(apis: ReadonlySet<string> | undefined, original: Original | undefined): string | undefined {
  if (original?.baseUrl === undefined) return 'no base URL'
  const unserved = [...(apis ?? [])].filter((api) => !Object.hasOwn(SERVED_APIS, api))
  return unserved.length === 0 ? undefined : unserved.join(', ')
}
