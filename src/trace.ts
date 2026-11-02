// The anon trace: what the proxy sends upstream after the pipeline, and what the model answers before restore.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TraceEvent, TraceSink } from './contract.ts'

export const DEFAULT_TRACE_MAX_CHARS = 262_144

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
/** Top-level body keys whose array elements are traced one by one: the conversation history the harness resends each round. */
const PER_ELEMENT_KEYS: Record<string, true> = { messages: true, input: true }

/**
 * One JSON line (no trailing newline). When the JSON of `content` is longer than `maxChars`,
 * `content` becomes that JSON text cut to `maxChars` and `truncated` is set.
 */
export function serializeTraceEvent(event: TraceEvent, maxChars: number = DEFAULT_TRACE_MAX_CHARS): string {
  const content = JSON.stringify(event.content) as string | undefined
  if (content === undefined || content.length <= maxChars) return JSON.stringify(event)
  return JSON.stringify({ ...event, content: content.slice(0, maxChars), truncated: true })
}

export interface FileTraceSinkOptions {
  readonly dir: string
  readonly maxChars?: number
}

/** Appends each event to `<dir>/<session>.jsonl`. The files hold whatever leaked, so they are owner-only. */
export function createFileTraceSink(options: FileTraceSinkOptions): TraceSink {
  const maxChars = options.maxChars ?? DEFAULT_TRACE_MAX_CHARS
  let created = false
  return {
    record(event) {
      if (!created) {
        mkdirSync(options.dir, { recursive: true, mode: 0o700 })
        created = true
      }
      const file = join(options.dir, `${safeSessionId(event.sessionId)}.jsonl`)
      appendFileSync(file, `${serializeTraceEvent(event, maxChars)}\n`, { mode: 0o600 })
    },
  }
}

/** The id itself when it is a safe file name, otherwise a stable hash of it. */
export function safeSessionId(id: string): string {
  if (SAFE_SESSION_ID.test(id)) return id
  return `sha256-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
}

/**
 * The request entries not yet traced in this session, keyed by JSON path; adds their hashes to `traced`.
 * `messages`/`input` arrays count per element, every other top-level key as a whole.
 */
export function requestDelta(body: unknown, traced: Set<string>): Record<string, unknown> {
  const delta: Record<string, unknown> = {}
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return delta
  const add = (key: string, path: string, value: unknown): void => {
    const hash = createHash('sha256').update(`${key}\u0000${JSON.stringify(value)}`).digest('hex')
    if (traced.has(hash)) return
    traced.add(hash)
    delta[path] = value
  }
  for (const [key, value] of Object.entries(body)) {
    if (Object.hasOwn(PER_ELEMENT_KEYS, key) && Array.isArray(value)) {
      value.forEach((element, i) => add(key, `${key}[${i}]`, element))
    } else {
      add(key, key, value)
    }
  }
  return delta
}
