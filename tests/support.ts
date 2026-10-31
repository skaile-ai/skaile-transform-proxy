import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TextLeaf, Transform, TransformModule } from '../src/contract.ts'
import type { InboundStream } from '../src/index.ts'

/** mulberry32: a small seeded PRNG so random chunkings are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Splits `text` at the given sorted offsets. */
export function splitAt(text: string, cuts: readonly number[]): string[] {
  const out: string[] = []
  let previous = 0
  for (const cut of cuts) {
    out.push(text.slice(previous, cut))
    previous = cut
  }
  out.push(text.slice(previous))
  return out
}

/** Splits bytes into fixed-size pieces, so tests can cut multi-byte UTF-8 characters. */
export function splitBytes(bytes: Buffer, size: number): Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size))
  return out
}

/** Whole-text replacement, longest key first, single pass. */
export function replaceAll(text: string, map: Readonly<Record<string, string>>): string {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length)
  if (keys.length === 0) return text
  const pattern = new RegExp(keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  return text.replace(pattern, (match) => map[match] ?? match)
}

/** Length of the longest suffix of `pending` that is a prefix of some key: that tail must be held back. */
function heldLength(pending: string, keys: readonly string[]): number {
  const longest = keys.reduce((max, key) => Math.max(max, key.length), 0)
  for (let len = Math.min(pending.length, longest); len > 0; len--) {
    const suffix = pending.slice(pending.length - len)
    if (keys.some((key) => key.startsWith(suffix))) return len
  }
  return 0
}

/** Streaming inverse of `replaceAll`: holds back any tail that could still grow into a key. */
export function streamingReplace(map: Readonly<Record<string, string>>): InboundStream {
  const keys = Object.keys(map)
  let pending = ''
  return {
    push(chunk: string): string {
      pending += chunk
      const hold = heldLength(pending, keys)
      const emit = pending.slice(0, pending.length - hold)
      pending = pending.slice(pending.length - hold)
      return replaceAll(emit, map)
    },
    flush(): string {
      const out = replaceAll(pending, map)
      pending = ''
      return out
    },
  }
}

export interface ReplacerOptions {
  readonly instruction?: string
  readonly outbound?: Readonly<Record<string, string>>
  readonly inbound?: Readonly<Record<string, string>>
  /** Outbound throws when the text contains this string. */
  readonly fail?: string
  readonly onOutbound?: (text: string, leaf: TextLeaf) => void
  readonly onDispose?: () => void
}

/** A transform that replaces literal strings on the way out and on the way back. */
export function replacer(options: ReplacerOptions = {}): Transform {
  return {
    ...(options.instruction === undefined ? {} : { instruction: options.instruction }),
    async outbound(text: string, leaf: TextLeaf): Promise<string> {
      options.onOutbound?.(text, leaf)
      if (options.fail !== undefined && text.includes(options.fail)) throw new Error(`refused: ${options.fail}`)
      return replaceAll(text, options.outbound ?? {})
    },
    inbound(text: string): string {
      return replaceAll(text, options.inbound ?? {})
    },
    inboundStream(): InboundStream {
      return streamingReplace(options.inbound ?? {})
    },
    dispose() {
      options.onDispose?.()
    },
  }
}

const DEFAULT_OUTBOUND: Readonly<Record<string, string>> = { Alice: 'P1' }
const DEFAULT_INBOUND: Readonly<Record<string, string>> = { P1: 'Alice' }

export interface ScriptedConfig {
  readonly instruction?: string
  readonly outbound?: Readonly<Record<string, string>>
  readonly inbound?: Readonly<Record<string, string>>
  readonly fail?: string
  /** The first N factory calls reject. */
  readonly failFactories?: number
  /** Each factory call waits this long before resolving. */
  readonly factoryDelayMs?: number
}

export interface OutboundCall {
  readonly text: string
  readonly leaf: TextLeaf
  /** The session facts visible to the transform at call time, as `kind:value`. */
  readonly facts: string[]
}

export interface ScriptedProbe {
  /** Session id of every factory call (one per built instance). */
  readonly factories: string[]
  readonly outbound: OutboundCall[]
  /** Session id of every disposed instance. */
  readonly disposed: string[]
}

/** A `TransformModule` that replaces `Alice` with `P1` and back, with failure and delay switches. */
export function scriptedModule(config: ScriptedConfig = {}): { module: TransformModule; probe: ScriptedProbe } {
  const probe: { factories: string[]; outbound: OutboundCall[]; disposed: string[] } = {
    factories: [],
    outbound: [],
    disposed: [],
  }
  let failuresLeft = config.failFactories ?? 0
  const module: TransformModule = {
    id: 'scripted',
    open: async () => async (ctx) => {
      probe.factories.push(ctx.sessionId)
      if (config.factoryDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, config.factoryDelayMs))
      if (failuresLeft > 0) {
        failuresLeft -= 1
        throw new Error('factory refused')
      }
      return replacer({
        instruction: config.instruction,
        outbound: config.outbound ?? DEFAULT_OUTBOUND,
        inbound: config.inbound ?? DEFAULT_INBOUND,
        fail: config.fail,
        onOutbound: (text, leaf) => {
          probe.outbound.push({ text, leaf, facts: ctx.facts.list().map((fact) => `${fact.kind}:${fact.value}`) })
        },
        onDispose: () => {
          probe.disposed.push(ctx.sessionId)
        },
      })
    },
  }
  return { module, probe }
}

export interface UpstreamReply {
  readonly status?: number
  readonly headers?: Record<string, string>
  /** A string is written whole; an array is written piece by piece, so tests can split at any byte. */
  readonly body: string | readonly Buffer[]
}

export interface UpstreamRequest {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

export interface FakeUpstream {
  readonly url: string
  readonly requests: UpstreamRequest[]
  reply: UpstreamReply
  close(): Promise<void>
}

const JSON_REPLY: UpstreamReply = {
  body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }),
}

async function writeReply(res: ServerResponse, reply: UpstreamReply): Promise<void> {
  res.writeHead(reply.status ?? 200, reply.headers ?? { 'content-type': 'application/json' })
  const pieces = typeof reply.body === 'string' ? [Buffer.from(reply.body)] : reply.body
  for (const piece of pieces) {
    res.write(piece)
    await new Promise((resolve) => setImmediate(resolve))
  }
  res.end()
}

/** A loopback HTTP server that records every request and answers with `reply`. */
export async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: UpstreamRequest[] = []
  const upstream: { reply: UpstreamReply } = { reply: JSON_REPLY }
  const server = createServer((req, res) => {
    const received: Buffer[] = []
    req.on('data', (chunk: Buffer) => received.push(chunk))
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(received).toString('utf8'),
      })
      void writeReply(res, upstream.reply)
    })
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get reply() {
      return upstream.reply
    },
    set reply(value: UpstreamReply) {
      upstream.reply = value
    },
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
      server.closeAllConnections()
      await closed
    },
  }
}
