import type { SessionFacts, TraceLeak, Transform } from './contract.ts'

/** A value the proxy knows to be an original (a session fact, or something a transform replaced). */
export interface KnownOriginal {
  readonly kind: string
  readonly source: string
  readonly value: string
}

/** Shorter values match by chance too often to be worth a warning. */
const MIN_LEAK_LENGTH = 3
const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/

/**
 * The values the leak check compares against: the session's facts, each with its publisher as source, plus what the
 * pipeline instance reports via `knownOriginals()` as source `pipeline`. If that throws, only the facts are returned.
 */
export function knownOriginals(facts: SessionFacts, instance?: Transform): KnownOriginal[] {
  const out: KnownOriginal[] = facts.list().map(({ kind, source, value }) => ({ kind, source, value }))
  if (instance?.knownOriginals === undefined) return out
  try {
    const fromPipeline: KnownOriginal[] = []
    for (const { kind, value } of instance.knownOriginals()) fromPipeline.push({ kind, source: 'pipeline', value })
    out.push(...fromPipeline)
  } catch {
    // A failing transform must not break the request; the facts are still checked.
  }
  return out
}

/**
 * Every place in `body` (the rewritten request) where a string value contains a known original, case-sensitively.
 * Only string values are scanned, not object keys. The result holds kind, source and JSON path, never the value.
 */
export function findLeaks(body: unknown, originals: Iterable<KnownOriginal>): TraceLeak[] {
  const candidates: KnownOriginal[] = []
  for (const original of originals) if (original.value.length >= MIN_LEAK_LENGTH) candidates.push(original)
  if (candidates.length === 0) return []

  const leaks: TraceLeak[] = []
  const seen = new Set<string>()
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const { kind, source, value } of candidates) {
        if (!node.includes(value)) continue
        const key = JSON.stringify([kind, source, path])
        if (seen.has(key)) continue
        seen.add(key)
        leaks.push({ kind, source, at: path })
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`))
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) visit(value, joinKey(path, key))
    }
  }
  visit(body, '')
  return leaks
}

function joinKey(path: string, key: string): string {
  if (!PLAIN_KEY.test(key)) return `${path}[${JSON.stringify(key)}]`
  return path === '' ? key : `${path}.${key}`
}
