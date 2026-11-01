// omp extension: `/anon on|off|status` routes every provider of the model registry through the transform proxy.
import { homedir } from 'node:os'
import { errorMessage } from '../log.ts'
import { createAnonController, type AnonController, type ImageSending } from './anon.ts'
import type { OmpContext, OmpEventName, OmpExtensionApi } from './types.ts'

export {
  createAnonController,
  defaultStatePath,
  type AnonController,
  type AnonControllerDeps,
  type ImageSending,
  type ProxyChildProcess,
  type ProxySpawnOptions,
} from './anon.ts'
export type * from './types.ts'

/** omp re-imports the extension per session; the controller (proxy child, recorded originals) is process-wide. */
const CONTROLLER_KEY = Symbol.for('@skaile/transform-proxy/omp')
const BLOCK_IMAGES = 'images.blockImages'

interface OmpSettingHandle {
  /** Writes omp's in-memory runtime layer: never persisted, outranks every settings file. */
  override(scope: unknown, value: unknown): void
  /** Drops the runtime layer, so the user's configured value applies again. */
  clearOverride(scope: unknown): void
}

/** Registers the `/anon` command and the event handlers on one session's extension API. */
export function registerAnonExtension(pi: OmpExtensionApi, controller: AnonController): void {
  pi.registerCommand('anon', {
    description: 'Route model requests through the skaile transform proxy: on | off | status',
    getArgumentCompletions: (prefix) => controller.completions(prefix),
    handler: (args, ctx) => guarded(ctx, () => controller.command(args, ctx, pi)),
  })
  on(pi, 'session_start', (ctx) => controller.sessionStart(ctx, pi))
  on(pi, 'session_switch', (ctx) => controller.sessionSwitch(ctx, pi))
  // Providers can appear or be reset mid-session (model refresh, /login, subagent session setup).
  on(pi, 'before_agent_start', (ctx) => controller.reapply(ctx, pi))
  on(pi, 'turn_start', (ctx) => controller.reapply(ctx, pi))
  // The last line of defence: a request that would bypass the proxy loses its payload.
  pi.on('before_provider_request', (_event, ctx) => controller.providerRequest(ctx))
}

export default function anonExtension(pi: OmpExtensionApi): void {
  const scope = globalThis as Record<symbol, AnonController | undefined>
  const controller = (scope[CONTROLLER_KEY] ??= createAnonController({ env: process.env, home: homedir(), images: ompImageSending(pi) }))
  registerAnonExtension(pi, controller)
}

/** Blocks images through a runtime override of omp's `images.blockImages`, which strips them from every request, history included. */
export function ompImageSending(pi: OmpExtensionApi, load: () => Promise<unknown> = loadOmpSettingsRegistry): ImageSending {
  let handle: Promise<OmpSettingHandle | undefined> | undefined
  return {
    async setBlocked(blocked) {
      const settings = pi.pi?.settings
      if (settings === undefined) return false
      handle ??= load().then(blockImagesHandle, () => undefined)
      const resolved = await handle
      if (resolved === undefined) return false
      if (blocked) resolved.override(settings, true)
      else resolved.clearOverride(settings)
      return true
    },
  }
}

function loadOmpSettingsRegistry(): Promise<unknown> {
  // Dynamic: the module exists only inside omp, which serves it to extensions by rewriting this
  // literal specifier at load time (a specifier held in a variable is not rewritten and fails).
  return import('@oh-my-pi/pi-coding-agent/config/registry')
}

function blockImagesHandle(registry: unknown): OmpSettingHandle | undefined {
  if (typeof registry !== 'object' || registry === null || !('lookup' in registry) || typeof registry.lookup !== 'function') return undefined
  const handle: unknown = registry.lookup(BLOCK_IMAGES)
  if (typeof handle !== 'object' || handle === null) return undefined
  if (!('override' in handle) || typeof handle.override !== 'function') return undefined
  if (!('clearOverride' in handle) || typeof handle.clearOverride !== 'function') return undefined
  // Both methods were checked above; the cast only names them.
  return handle as OmpSettingHandle
}

function on(pi: OmpExtensionApi, event: OmpEventName, run: (ctx: OmpContext) => Promise<void>): void {
  pi.on(event, (_event, ctx) => guarded(ctx, () => run(ctx)))
}

async function guarded(ctx: OmpContext, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    ctx.ui.notify(`anon: ${errorMessage(err)}`, 'error')
  }
}
