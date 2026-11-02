import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { configCandidates, findProxyConfig, loadProxyConfig } from '../config.ts'
import { errorMessage } from '../log.ts'
import { SESSION_HEADER, TOKEN_HEADER, UPSTREAM_HEADER } from '../server.ts'
import type { OmpAutocompleteItem, OmpContext, OmpModel, OmpModelRegistry, OmpSessionActions } from './types.ts'

/** A running proxy the extension routes to. */
export const URL_ENV = 'SKAILE_TRANSFORM_PROXY_URL'
/** The client token of that proxy; also how the extension hands its own proxy child a random token. */
export const TOKEN_ENV = 'SKAILE_TRANSFORM_PROXY_TOKEN'
/** The Node binary that runs the proxy child; default: `node` from `PATH`. */
export const NODE_ENV = 'SKAILE_TRANSFORM_PROXY_NODE'
/** `required` (set by a skaile session in required mode): routing is forced on and `/anon off` is refused. */
export const MODE_ENV = 'SKAILE_TRANSFORM_PROXY_MODE'
/** Overrides the path of the saved default (`/anon on|off --global`). */
export const STATE_ENV = 'SKAILE_TRANSFORM_PROXY_OMP_STATE'
/** The proxy's trace directory (relative to the cwd); the own proxy child inherits it with the rest of the environment. */
export const TRACE_DIR_ENV = 'SKAILE_TRANSFORM_PROXY_TRACE_DIR'
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

/** `/anon on --global` / `/anon off --global` also save the default that new omp sessions start with. */
const GLOBAL_FLAG = '--global'
const USAGE = 'usage: /anon on|off [--global] | status'
const VERBS: readonly OmpAutocompleteItem[] = [
  { value: 'on', label: 'on', description: 'route this session through the transform proxy' },
  { value: 'on --global', label: 'on --global', description: 'on, and the default for new sessions' },
  { value: 'off', label: 'off', description: 'restore this session\'s original provider base URLs' },
  { value: 'off --global', label: 'off --global', description: 'off, and the default for new sessions' },
  { value: 'status', label: 'status', description: 'show the proxy, pipeline and routed providers' },
]

/** A parsed `/anon` argument; `undefined` for anything else. */
function parseCommand(args: string): { verb: 'on' | 'off' | 'status'; global: boolean } | undefined {
  const [verb = '', ...flags] = args.trim().toLowerCase().split(/\s+/)
  if (verb === '' || verb === 'status') return flags.length === 0 ? { verb: 'status', global: false } : undefined
  if (verb !== 'on' && verb !== 'off') return undefined
  if (flags.length === 0) return { verb, global: false }
  return flags.length === 1 && flags[0] === GLOBAL_FLAG ? { verb, global: true } : undefined
}

/** How the extension spawns its proxy child. */
export interface ProxySpawnOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdio: readonly ['pipe', 'pipe', 'pipe']
}

/** The slice of a `node:child_process` `ChildProcess` the extension uses. */
export interface ProxyChildProcess {
  readonly pid?: number | undefined
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  unref(): void
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

/**
 * Image sending of the host. The proxy cannot anonymize images and refuses every request that
 * carries one; omp resends the whole history each turn, so one screenshot would block the session.
 */
export interface ImageSending {
  /** `true` stops images from reaching the provider, `false` restores the user's setting. Resolves `false` when the host offers no way to do it; that answer is final. */
  setBlocked(blocked: boolean): Promise<boolean>
}

export interface AnonControllerDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  /** Default: `$SKAILE_TRANSFORM_PROXY_OMP_STATE`, else `<omp agent dir>/skaile-transform-proxy.json`. */
  readonly statePath?: string
  /** Spawns the proxy child. Default: `node:child_process` `spawn`. */
  readonly spawnChild?: (command: string, args: readonly string[], options: ProxySpawnOptions) => ProxyChildProcess
  /** The CLI the child runs. Default: this package's `dist/cli.mjs`, next to the built extension's `dist/omp/`. */
  readonly cliPath?: string
  /** How long the child may take to print `listening <url>`. Default: 60 s (transform modules may load ML models). */
  readonly listenTimeoutMs?: number
  /** Blocked while anon is wanted (on, error or required), released by `/anon off`. Default: none. */
  readonly images?: ImageSending
}

export interface AnonController {
  readonly required: boolean
  readonly statePath: string
  /** Handles `/anon <args>`. `session` rebinds the session's active model after a switch. */
  command(args: string, ctx: OmpContext, session: OmpSessionActions): Promise<void>
  completions(prefix: string): OmpAutocompleteItem[] | null
  /**
   * Applies the saved default (unless `/anon on|off` already decided in this process) or required
   * mode, and refreshes the status bar. A root session
   * whose omp session id changed rotates the proxy session; subagents keep the parent's id.
   */
  sessionStart(ctx: OmpContext, session: OmpSessionActions): Promise<void>
  /** `/new`, `/resume`, `/fork`: the root session changed, so the proxy session rotates. */
  sessionSwitch(ctx: OmpContext, session: OmpSessionActions): Promise<void>
  /** While on (or failed): routes providers that appeared, or were reset, since the last pass. */
  reapply(ctx: OmpContext, session: OmpSessionActions): Promise<void>
  /**
   * `before_provider_request`: while anon is on, failed or required, a request whose model does
   * not target the transform proxy gets a replacement payload without any conversation text.
   * Returns `undefined` to keep the payload.
   */
  providerRequest(ctx: OmpContext): Record<string, never> | undefined
}

interface Endpoint {
  readonly url: string
  readonly token?: string
  /** The pipeline the proxy applies; `undefined` = the proxy's default (unknown here). */
  readonly pipeline?: string
  readonly source: string
  /** Set for the extension's own proxy child; `exited` flips when it dies, so the next activation starts a new one. */
  readonly child?: { exited: boolean }
  /** The own child's trace dir from its config `trace.dir`; the env var wins over it. */
  readonly traceDir?: string
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
  /** Routed provider -> the session id its override carries. */
  readonly routed: Map<string, string>
}

/**
 * The process-wide `/anon` state machine. omp builds one extension instance per session
 * (subagents included) while they share one model registry, so one controller serves them all.
 *
 * `wanted`: model requests must go through the proxy (required mode, or `/anon on`).
 * `enabled`: every provider is routed and the active model is rebound. `wanted` without
 * `enabled` is the error state: the status shows `🟠A` and `providerRequest` refuses
 * every request that would bypass the proxy.
 */
export function createAnonController(deps: AnonControllerDeps): AnonController {
  const env = deps.env
  const required = env[MODE_ENV] === 'required'
  const statePath = deps.statePath ?? defaultStatePath(env, deps.home)
  const spawnChild = deps.spawnChild ?? spawnNode
  const listenTimeoutMs = deps.listenTimeoutMs ?? 60_000
  const registries = new WeakMap<OmpModelRegistry, RegistryState>()
  let wanted = required
  let enabled = false
  /** The last successful `/anon on|off` in this omp process; once set, the saved default no longer applies here. */
  let local: boolean | undefined
  /** Whether this controller holds the image block; only then does it release it. */
  let imagesBlocked = false
  /** The host answered that it cannot block images; asked once, warned once. */
  let imagesUnsupported = false
  let endpoint: Endpoint | undefined
  let starting: Promise<Endpoint> | undefined
  let sessionId: string | undefined

  function stateOf(registry: OmpModelRegistry): RegistryState {
    let state = registries.get(registry)
    if (state === undefined) {
      state = { originals: new Map(), routed: new Map() }
      registries.set(registry, state)
    }
    return state
  }

  async function resolveEndpoint(ctx: OmpContext): Promise<Endpoint> {
    if (endpoint !== undefined && endpoint.child?.exited !== true) return endpoint
    const url = env[URL_ENV]
    if (url !== undefined && url !== '') {
      const token = env[TOKEN_ENV]
      endpoint = { url, ...(token ? { token } : {}), source: URL_ENV }
      return endpoint
    }
    starting ??= startChild(ctx.cwd).finally(() => {
      starting = undefined
    })
    endpoint = await starting
    return endpoint
  }

  /**
   * Runs the proxy CLI under the system Node: omp is a compiled Bun executable whose resolver
   * cannot load transform modules with native or ML dependencies from `node_modules`.
   */
  async function startChild(cwd: string): Promise<Endpoint> {
    const path = findProxyConfig({ cwd, home: deps.home })
    if (path === undefined) {
      const searched = configCandidates(cwd, deps.home).join(' or ')
      throw new Error(`no transform proxy config found: create ${searched}, or set ${URL_ENV} to a running proxy`)
    }
    const options = loadProxyConfig(path)
    if (options.defaultPipeline === undefined) {
      throw new Error(`${path} sets no defaultPipeline: the omp extension sends no pipeline header`)
    }
    const token = randomBytes(32).toString('base64url')
    const node = env[NODE_ENV] || 'node'
    const cli = deps.cliPath ?? fileURLToPath(new URL('../cli.mjs', import.meta.url))
    const child = spawnChild(node, [cli, '--config', path, '--port', '0', '--host', '127.0.0.1', '--exit-with-stdin'], {
      cwd,
      env: { ...env, [TOKEN_ENV]: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const state = { exited: false }
    child.on('exit', () => {
      state.exited = true
      if (endpoint?.child === state) endpoint = undefined
    })
    const url = await waitForListening(child, { node, token, timeoutMs: listenTimeoutMs })
    return {
      url,
      token,
      pipeline: options.defaultPipeline,
      source: `child process ${child.pid}, config ${path}`,
      child: state,
      ...(options.trace === undefined ? {} : { traceDir: options.trace.dir }),
    }
  }

  function currentSessionId(ctx: OmpContext): string {
    sessionId ??= readSessionId(ctx) ?? randomUUID()
    return sessionId
  }

  /**
   * Adopts the session id of a root session. The first session of the process is the root;
   * later `session_start`s are subagents (headless, `print` mode) unless the session has a UI
   * or runs in another mode.
   */
  function enterSession(ctx: OmpContext, root: boolean): void {
    if (sessionId === undefined) currentSessionId(ctx)
    else if (root) sessionId = readSessionId(ctx) ?? sessionId
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
      if (state.routed.get(provider) === session && registry.getProviderBaseUrl(provider) === target.url) continue
      // omp merges these into the provider's existing headers, so its own headers stay in place.
      const headers: Record<string, string> = { [SESSION_HEADER]: session }
      if (original.baseUrl !== undefined) headers[UPSTREAM_HEADER] = original.baseUrl
      if (target.token !== undefined) headers[TOKEN_HEADER] = target.token
      registry.registerProvider(provider, { baseUrl: target.url, headers }, SOURCE_ID)
      state.routed.set(provider, session)
    }
  }

  /** Clears the proxy overrides; re-applies the recorded original where another override was layered underneath. */
  function unroute(ctx: OmpContext): string[] {
    const registry = ctx.modelRegistry
    const state = stateOf(registry)
    // A re-registration would merge, not remove, the proxy headers: only clearing the source drops them.
    registry.clearSourceRegistrations(SOURCE_ID)
    const lost: string[] = []
    for (const provider of state.routed.keys()) {
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

  /**
   * Routes every provider and rebinds the active model. Returns the failure, or `undefined`.
   * A failed rebind leaves the session on a model that bypasses the proxy: outside required
   * mode the routes are rolled back, so the registry matches the state shown.
   */
  async function activate(ctx: OmpContext, session: OmpSessionActions): Promise<string | undefined> {
    let target: Endpoint
    try {
      target = await resolveEndpoint(ctx)
    } catch (err) {
      enabled = false
      return errorMessage(err)
    }
    route(ctx, target)
    if (await rebind(ctx, session)) {
      enabled = true
      return undefined
    }
    if (!required) unroute(ctx)
    enabled = false
    const active = ctx.model
    return `could not rebind the active model ${active?.provider}/${active?.id} to the transform proxy`
  }

  /** The session holds its active model as a snapshot: swap in the registry's re-projected one. */
  async function rebind(ctx: OmpContext, session: OmpSessionActions): Promise<boolean> {
    const active = ctx.model
    if (active === undefined) return true
    const live = ctx.modelRegistry.find(active.provider, active.id)
    if (live === undefined) return false
    if (live.baseUrl === active.baseUrl && live.headers?.[SESSION_HEADER] === active.headers?.[SESSION_HEADER]) return true
    try {
      return await session.setModel(live)
    } catch {
      return false
    }
  }

  /** Why a request of `model` would bypass the proxy, or `undefined` when it targets it. */
  function bypassReason(ctx: OmpContext, model: OmpModel | undefined): string | undefined {
    if (model === undefined) return 'the request names no model'
    if (stateOf(ctx.modelRegistry).originals.get(model.provider)?.preRouted === true) return undefined
    const proxyOrigin = endpoint === undefined ? undefined : originOf(endpoint.url)
    if (proxyOrigin === undefined) return 'the transform proxy is not available'
    if (model.baseUrl === undefined || originOf(model.baseUrl) !== proxyOrigin) {
      return `${model.provider}/${model.id} does not target the transform proxy`
    }
    return undefined
  }

  function refusalHint(): string {
    return required
      ? `anon: required mode: model requests are refused until the transform proxy is routed (${MODE_ENV}=required)`
      : 'anon: model requests are refused until /anon on succeeds; /anon off sends them directly'
  }

  function persist(ctx: OmpContext, value: boolean): void {
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, `${JSON.stringify({ enabled: value }, null, 2)}\n`)
    } catch (err) {
      ctx.ui.notify(`anon: could not save ${statePath}: ${errorMessage(err)}`, 'warning')
    }
  }

  function stateLabel(): string {
    return enabled ? 'on' : wanted ? 'error' : 'off'
  }

  /** Follows `wanted`: images are blocked while model requests must go through the proxy. */
  async function syncImages(ctx: OmpContext): Promise<void> {
    const images = deps.images
    if (images === undefined || imagesUnsupported || imagesBlocked === wanted) return
    let done: boolean
    try {
      done = await images.setBlocked(wanted)
    } catch (err) {
      // A failed write may succeed on the next command.
      ctx.ui.notify(`anon: could not ${wanted ? 'stop' : 'restore'} image sending: ${errorMessage(err)}`, 'warning')
      return
    }
    if (done) {
      imagesBlocked = wanted
      return
    }
    imagesUnsupported = true
    if (wanted) ctx.ui.notify('anon: this omp cannot stop image sending; the proxy refuses every request that carries an image', 'warning')
  }

  /**
   * Compact status for omp's main status line. omp strips ANSI colour from extension statuses and
   * paints them in its accent colour, so the colour comes from an emoji: green on, red off, orange error.
   */
  function showStatus(ctx: OmpContext): void {
    ctx.ui.setStatus(STATUS_KEY, enabled ? '🟢A' : wanted ? '🟠A' : '🔴A')
  }

  function statusText(ctx: OmpContext): string {
    const registry = ctx.modelRegistry
    const state = stateOf(registry)
    const apis = providerApis(registry)
    const lines = [`anon ${stateLabel()}${required ? ' (required)' : ''}`]
    if (endpoint !== undefined) {
      lines.push(`proxy: ${endpoint.url} (${endpoint.source})`)
      lines.push(`pipeline: ${endpoint.pipeline ?? 'the proxy default'}`)
    }
    if (sessionId !== undefined) lines.push(`session: ${sessionId}`)
    lines.push(`trace: ${traceTarget(ctx.cwd)}`)
    if (imagesBlocked) lines.push('images: not sent (omp images.blockImages)')
    const routed = [...state.routed.keys()].sort()
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

  /** The proxy's trace directory, or `off`. With an external proxy only the env var is known here. */
  function traceTarget(cwd: string): string {
    const fromEnv = env[TRACE_DIR_ENV]
    if (fromEnv !== undefined && fromEnv !== '') return resolve(cwd, fromEnv)
    return endpoint?.traceDir ?? 'off'
  }

  /**
   * Session entry: rotate the proxy session for a new root, then (re-)apply routing when wanted.
   * Rotation only switches the session header: the proxy keeps the old session's state in memory
   * until it exits, and no request carries that id again.
   */
  async function start(ctx: OmpContext, session: OmpSessionActions, root: boolean): Promise<void> {
    enterSession(ctx, root)
    // The saved default applies until `/anon on|off` decides for this omp process.
    if (!wanted && local === undefined && readEnabled(statePath)) wanted = true
    if (wanted) {
      const failure = await activate(ctx, session)
      if (failure !== undefined) {
        ctx.ui.notify(`anon: ${failure}`, 'error')
        ctx.ui.notify(refusalHint(), 'error')
      }
    }
    await syncImages(ctx)
    showStatus(ctx)
  }

  return {
    required,
    statePath,

    async command(args, ctx, session) {
      const parsed = parseCommand(args)
      const scope = parsed?.global === true ? `this session; default for new sessions: ${parsed.verb}` : 'this session'
      switch (parsed?.verb) {
        case 'on': {
          const before = wanted
          wanted = true
          const failure = await activate(ctx, session)
          if (failure === undefined) {
            local = true
            if (parsed.global) persist(ctx, true)
            const count = stateOf(ctx.modelRegistry).routed.size
            ctx.ui.notify(`anon on (${scope}): ${count} provider(s) routed through ${endpoint?.url}`, 'info')
            break
          }
          // A failed `on` changes nothing: no default is saved, and an off state stays off.
          wanted = before || required
          ctx.ui.notify(`anon: ${failure}`, 'error')
          if (wanted) ctx.ui.notify(refusalHint(), 'error')
          break
        }
        case 'off': {
          if (required) {
            ctx.ui.notify(`anon: off refused: this session requires the transform proxy (${MODE_ENV}=required)`, 'warning')
            break
          }
          const lost = unroute(ctx)
          wanted = false
          enabled = false
          local = false
          if (!(await rebind(ctx, session))) {
            ctx.ui.notify(`anon: could not rebind the active model ${ctx.model?.provider}/${ctx.model?.id}; select it again`, 'warning')
          }
          if (parsed.global) persist(ctx, false)
          ctx.ui.notify(`anon off (${scope}): original provider base URLs restored`, 'info')
          if (lost.length > 0) {
            ctx.ui.notify(
              `anon: ${lost.join(', ')} lost their runtime registration (registered by another extension); restart omp to restore them`,
              'warning',
            )
          }
          break
        }
        case 'status':
          ctx.ui.notify(statusText(ctx), 'info')
          break
        default:
          ctx.ui.notify(USAGE, 'error')
      }
      await syncImages(ctx)
      showStatus(ctx)
    },

    completions(prefix) {
      const needle = prefix.trim().toLowerCase()
      const items = VERBS.filter((item) => item.value.startsWith(needle))
      return items.length > 0 ? items : null
    },

    sessionStart(ctx, session) {
      return start(ctx, session, ctx.hasUI === true || (ctx.mode !== undefined && ctx.mode !== 'print'))
    },

    sessionSwitch(ctx, session) {
      return start(ctx, session, true)
    },

    async reapply(ctx, session) {
      if (!wanted) return
      const was = enabled
      const failure = await activate(ctx, session)
      if (failure !== undefined && was) {
        ctx.ui.notify(`anon: ${failure}`, 'error')
        ctx.ui.notify(refusalHint(), 'error')
      }
      if (enabled !== was) showStatus(ctx)
    },

    providerRequest(ctx) {
      if (!wanted) return undefined
      let reason: string | undefined
      try {
        reason = bypassReason(ctx, ctx.model)
      } catch (err) {
        reason = errorMessage(err)
      }
      if (reason === undefined) return undefined
      // omp has no hook that cancels a provider request, and a throwing handler is only logged:
      // the payload is replaced with one that carries no conversation text, which the upstream refuses.
      ctx.ui.notify(`anon: model request refused: ${reason}`, 'error')
      return {}
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

function spawnNode(command: string, args: readonly string[], options: ProxySpawnOptions): ProxyChildProcess {
  return spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: [...options.stdio] })
}

/** The stderr lines a startup failure quotes. */
const STDERR_TAIL = 10

/**
 * Resolves with the URL of the child's `listening <url>` line. A child that exits first, fails
 * to spawn or stays silent past `timeoutMs` (it is then killed) rejects, quoting its last stderr
 * lines with the token redacted. omp exiting kills the child; once listening, the child and its
 * pipes no longer hold omp's event loop, and stdin stays open so the child sees omp go away.
 */
function waitForListening(child: ProxyChildProcess, how: { readonly node: string; readonly token: string; readonly timeoutMs: number }): Promise<string> {
  const killOnExit = (): void => {
    child.kill('SIGTERM')
  }
  process.on('exit', killOnExit)
  const forgetExitHook = (): void => {
    process.off('exit', killOnExit)
  }
  child.on('exit', forgetExitHook)
  // Never write to stdin; a stray pipe error must not crash omp.
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => {})

  const listening = Promise.withResolvers<string>()
  const label = `the transform proxy child process (${how.node}, pid ${child.pid})`
  const tail: string[] = []
  let stderrPartial = ''
  let stdout = ''
  let settled = false

  function stderrTail(): string {
    const lines = [...tail, stderrPartial].filter((line) => line.trim() !== '').slice(-STDERR_TAIL)
    return lines.length === 0 ? '(none)' : lines.map((line) => line.split(how.token).join('[token]')).join('\n')
  }

  function fail(message: string): void {
    if (settled) return
    settled = true
    clearTimeout(timer)
    listening.reject(new Error(message))
  }

  const timer = setTimeout(() => {
    fail(`${label} did not print "listening" within ${duration(how.timeoutMs)} and was killed; last stderr lines:\n${stderrTail()}`)
    child.kill('SIGKILL')
  }, how.timeoutMs)

  // After startup the handlers keep draining both pipes, so a chatty child never blocks on a full pipe.
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (settled) return
    const lines = (stderrPartial + String(chunk)).split('\n')
    stderrPartial = lines.pop() ?? ''
    tail.push(...lines.map((line) => line.replace(/\r$/, '')))
    tail.splice(0, Math.max(0, tail.length - STDERR_TAIL))
  })

  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (settled) return
    const lines = (stdout + String(chunk)).split('\n')
    stdout = lines.pop() ?? ''
    for (const line of lines) {
      const match = /^listening (\S+)$/.exec(line.trim())
      if (match === null) continue
      settled = true
      clearTimeout(timer)
      stdout = ''
      child.unref()
      for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as { unref?: () => void } | null)?.unref?.()
      listening.resolve(match[1]!)
      return
    }
  })

  child.on('exit', (code, signal) => {
    if (settled) return
    // Quote stderr only once the pipe has drained: `exit` can fire before the last chunks arrive.
    const report = (): void =>
      fail(`${label} exited with ${code === null ? `signal ${signal}` : `code ${code}`} before it was listening; last stderr lines:\n${stderrTail()}`)
    const stderr = child.stderr
    if (stderr === null || stderr.readableEnded || stderr.destroyed) report()
    else {
      stderr.once('end', report)
      stderr.once('close', report)
    }
  })

  child.on('error', (err) => {
    forgetExitHook()
    fail(`could not start the transform proxy with "${how.node}": ${err.message}; it runs under Node >= 22: put node on PATH or set ${NODE_ENV}`)
  })

  return listening.promise
}

function duration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`
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

function readSessionId(ctx: OmpContext): string | undefined {
  try {
    const id: unknown = ctx.sessionManager.getSessionId()
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/** The origin of an http(s) URL; `undefined` for anything else, which never matches the proxy. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
