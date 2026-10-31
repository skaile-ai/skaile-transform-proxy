import type { Logger } from './contract.ts'

/** Default logger: drops everything. Hosts pass their own `Logger`. */
export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
