// omp extension: `/anon on|off|status` routes every provider of the model registry through the transform proxy.
import { homedir } from 'node:os'
import { errorMessage } from '../log.ts'
import { createAnonController, type AnonController } from './anon.ts'
import type { OmpContext, OmpEventName, OmpExtensionApi } from './types.ts'

export { createAnonController, defaultStatePath, type AnonController, type AnonControllerDeps } from './anon.ts'
export type * from './types.ts'

/** omp re-imports the extension per session; the controller (proxy, recorded originals) is process-wide. */
const CONTROLLER_KEY = Symbol.for('@skaile/transform-proxy/omp')

/** Registers the `/anon` command and the event handlers on one session's extension API. */
export function registerAnonExtension(pi: OmpExtensionApi, controller: AnonController): void {
  pi.registerCommand('anon', {
    description: 'Route model requests through the skaile transform proxy: on | off | status',
    getArgumentCompletions: (prefix) => controller.completions(prefix),
    handler: (args, ctx) => guarded(ctx, () => controller.command(args, ctx, pi)),
  })
  on(pi, 'session_start', (ctx) => controller.sessionStart(ctx, pi))
  // Providers can appear or be reset mid-session (model refresh, /login, subagent session setup).
  on(pi, 'before_agent_start', (ctx) => controller.reapply(ctx, pi))
  on(pi, 'turn_start', (ctx) => controller.reapply(ctx, pi))
}

export default function anonExtension(pi: OmpExtensionApi): void {
  const scope = globalThis as Record<symbol, AnonController | undefined>
  const controller = (scope[CONTROLLER_KEY] ??= createAnonController({ env: process.env, home: homedir() }))
  registerAnonExtension(pi, controller)
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
