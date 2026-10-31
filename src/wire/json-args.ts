// Restores placeholders inside the string values of streamed JSON text (tool-call arguments).
// Placeholders hold no JSON escape characters, so restoration runs on each decoded string value,
// and every restored original is JSON-escaped before it is written back into the fragment.

/** A streamed text restorer: `push` returns restored text; `flush` releases what it still holds. */
export interface TextRestorer {
  push(chunk: string): string
  flush(): string
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/** The body of a JSON string for `text`, without the surrounding quotes. */
export function escapeJsonBody(text: string): string {
  return JSON.stringify(text).slice(1, -1)
}

/**
 * Streaming restorer over raw JSON text. `openString` yields a fresh restorer for each string
 * value, so a placeholder never spans two values. Structural JSON outside strings passes through.
 */
export function createJsonArgRestorer(openString: () => TextRestorer): TextRestorer {
  let current: TextRestorer | undefined
  let escape: 'none' | 'backslash' | 'unicode' = 'none'
  let hex = ''

  return {
    push(fragment: string): string {
      let out = ''
      for (const ch of fragment) {
        if (current === undefined) {
          out += ch
          if (ch === '"') current = openString()
          continue
        }
        const restorer: TextRestorer = current
        if (escape === 'unicode') {
          hex += ch
          if (hex.length === 4) {
            out += escapeJsonBody(restorer.push(String.fromCharCode(Number.parseInt(hex, 16))))
            hex = ''
            escape = 'none'
          }
          continue
        }
        if (escape === 'backslash') {
          escape = 'none'
          if (ch === 'u') {
            escape = 'unicode'
            continue
          }
          out += escapeJsonBody(restorer.push(SIMPLE_ESCAPES[ch] ?? ch))
          continue
        }
        if (ch === '\\') {
          escape = 'backslash'
          continue
        }
        if (ch === '"') {
          out += escapeJsonBody(restorer.flush()) + '"'
          current = undefined
          continue
        }
        out += escapeJsonBody(restorer.push(ch))
      }
      return out
    },
    flush(): string {
      if (current === undefined) return ''
      const tail = escapeJsonBody(current.flush())
      current = undefined
      escape = 'none'
      hex = ''
      return tail
    },
  }
}
