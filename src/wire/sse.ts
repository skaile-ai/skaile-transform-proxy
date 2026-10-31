// SSE framing shared by the wire walkers. Events are split at any chunk boundary; unchanged
// events are re-emitted byte for byte, rewritten events are re-serialized with JSON.stringify.
import type { SseTransformer } from './types.ts'

/** One complete SSE event as received. `data` joins the event's `data:` lines with `\n`. */
export interface SseBlock {
  readonly event: string | undefined
  readonly data: string
  /** The event exactly as received, including its terminating blank line. */
  readonly raw: string
}

const DELIMITER = /\r?\n\r?\n/

export function parseSseBlock(raw: string): SseBlock {
  let event: string | undefined
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '')
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return { event, data: data.join('\n'), raw }
}

/** Serializes one rewritten event. `data` is JSON-encoded; the event name is kept when the source had one. */
export function formatSseEvent(event: string | undefined, data: unknown): string {
  const head = event === undefined ? '' : `event: ${event}\n`
  return `${head}data: ${JSON.stringify(data)}\n\n`
}

/**
 * Builds an SSE transformer. `handle` returns the output for one complete event (usually
 * `block.raw` or `formatSseEvent(...)`); `finish` returns output for state still open at end of stream.
 */
export function createSseFramer(handle: (block: SseBlock) => string, finish: () => string = () => ''): SseTransformer {
  let buffer = ''
  return {
    push(chunk: string): string {
      buffer += chunk
      let out = ''
      for (let match = DELIMITER.exec(buffer); match !== null; match = DELIMITER.exec(buffer)) {
        const end = match.index + match[0].length
        const raw = buffer.slice(0, end)
        buffer = buffer.slice(end)
        out += handle(parseSseBlock(raw))
      }
      return out
    },
    flush(): string {
      const rest = buffer
      buffer = ''
      const tail = rest === '' ? '' : handle(parseSseBlock(rest + '\n\n'))
      return tail + finish()
    },
  }
}
