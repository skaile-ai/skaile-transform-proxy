import type { Logger, Transform } from './contract.ts'
import { createSessionFacts, type SessionFactStore } from './facts.ts'
import { errorMessage } from './log.ts'

/** State kept per session id: facts, signed-reasoning cache, and one transform instance per pipeline. */
export interface SessionState {
  readonly facts: SessionFactStore
  /** Shared by every pipeline of the session; walkers namespace their keys. */
  readonly signatures: Map<string, string>
  /** Pipeline id -> the composed instance (or its pending build). */
  readonly instances: Map<string, Promise<Transform>>
}

export function createSessionState(): SessionState {
  return { facts: createSessionFacts(), signatures: new Map(), instances: new Map() }
}

/**
 * Returns the session's instance for a pipeline, building it on first use.
 * Concurrent first calls share one build; a failed build is forgotten so the next call retries.
 */
export function instanceFor(state: SessionState, pipelineId: string, build: () => Promise<Transform>): Promise<Transform> {
  const existing = state.instances.get(pipelineId)
  if (existing) return existing
  const pending: Promise<Transform> = build().catch((err: unknown) => {
    if (state.instances.get(pipelineId) === pending) state.instances.delete(pipelineId)
    throw err
  })
  state.instances.set(pipelineId, pending)
  return pending
}

/** Disposes every instance of a session, waiting for pending builds first. Dispose errors are logged. */
export async function disposeInstances(state: SessionState, log: Logger): Promise<void> {
  const settled = await Promise.allSettled([...state.instances.values()])
  state.instances.clear()
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    try {
      await result.value.dispose?.()
    } catch (err) {
      log.error(`transform dispose failed: ${errorMessage(err)}`)
    }
  }
}
