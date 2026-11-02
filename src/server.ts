import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { composeTransforms } from './chain.ts'
import type { Logger, SessionFactPublisher, SessionFacts, TraceEvent, TraceSink, Transform } from './contract.ts'
import { findLeaks, knownOriginals } from './leaks.ts'
import { errorMessage, silentLogger } from './log.ts'
import { openTransforms, type TransformSpec } from './modules.ts'
import { classify } from './routes.ts'
import { createSessionState, disposeInstances, instanceFor, type SessionState } from './sessions.ts'
import { requestDelta } from './trace.ts'
import { UnsupportedContentError, type SseTransformer, type WireContext, type WireWalker } from './wire/types.ts'

export interface TransformProxyOptions {
  /** Default 127.0.0.1. A non-loopback host requires `token`. */
  host?: string
  /** Default 0 (ephemeral). */
  port?: number
  /** Required `x-skaile-transform-token` when set. */
  token?: string
  /** Where transform module specifiers and configs resolve. */
  baseDir: string
  transforms: Readonly<Record<string, TransformSpec>>
  pipelines: Readonly<Record<string, readonly string[]>>
  /** Used when the request names no pipeline. Absent = such requests are refused. */
  defaultPipeline?: string
  /** Origins. Absent = any https origin plus loopback http. */
  allowUpstreams?: readonly string[]
  log?: Logger
  /** Records what goes upstream after the pipeline and what comes back before restore. Absent = no trace. */
  trace?: TraceSink
}

export interface TransformProxy {
  readonly url: string
  session(id: string): { readonly facts: SessionFacts; publisher(source: string): SessionFactPublisher }
  /** Disposes the session's transform instances and forgets its facts and caches. */
  dropSession(id: string): Promise<void>
  /**
   * Host-only, in-process: each stage's `inspect()` result of the session's pipeline instance, keyed by transform id.
   * `{}` when the session or pipeline is unknown, the instance is not built, or its build failed.
   * Never builds an instance or creates session state; there is no HTTP route for it. Rejects when a stage's `inspect()` throws.
   */
  inspect(sessionId: string, pipelineId?: string): Promise<Record<string, unknown>>
  close(): Promise<void>
}

export const UPSTREAM_HEADER = 'x-skaile-transform-upstream'
export const SESSION_HEADER = 'x-skaile-transform-session'
export const PIPELINE_HEADER = 'x-skaile-transform-pipeline'
export const TOKEN_HEADER = 'x-skaile-transform-token'

const DEFAULT_SESSION = 'default'
const LOOPBACK_HOSTS: Record<string, true> = { '127.0.0.1': true, localhost: true, '::1': true, '[::1]': true }
/** Connection-level headers: never forwarded in either direction. */
const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  'keep-alive': true,
  'proxy-connection': true,
  te: true,
  trailer: true,
  'transfer-encoding': true,
  upgrade: true,
}
const REQUEST_SKIP: Record<string, true> = {
  ...HOP_BY_HOP,
  host: true,
  'content-length': true,
  'accept-encoding': true,
}
/** Response headers the proxy re-derives: the body length and encoding after rewriting, and set-cookie (sent via getSetCookie). */
const RESPONSE_SKIP: Record<string, true> = {
  ...HOP_BY_HOP,
  'content-length': true,
  'content-encoding': true,
  'set-cookie': true,
}

/** Upstream error bodies in the trace are cut to this many characters. */
const ERROR_TRACE_CHARS = 4096

/** One proxied request's trace state: `base` is shared by its request, response and error lines. */
interface RequestTrace {
  readonly startedAt: number
  readonly base: Pick<TraceEvent, 'requestId' | 'sessionId' | 'pipeline' | 'route' | 'upstream' | 'model'>
}

export async function createTransformProxy(options: TransformProxyOptions): Promise<TransformProxy> {
  const log = options.log ?? silentLogger
  const host = options.host ?? '127.0.0.1'
  if (!Object.hasOwn(LOOPBACK_HOSTS, host) && options.token === undefined) {
    throw new Error(`transform proxy host ${host} is not loopback: a token is required`)
  }
  validatePipelines(options)
  const allowed = options.allowUpstreams === undefined ? undefined : new Set(options.allowUpstreams.map(originOf))
  const factories = await openTransforms(options.transforms, options.baseDir, log)
  const pipelines = options.pipelines
  const sessions = new Map<string, SessionState>()
  /** Composed instance -> its stages with their transform ids, for `inspect`. */
  const stagesOf = new WeakMap<Transform, readonly { id: string; transform: Transform }[]>()

  function stateFor(id: string): SessionState {
    const existing = sessions.get(id)
    if (existing) return existing
    const created = createSessionState()
    sessions.set(id, created)
    return created
  }

  /** A throwing sink is logged and otherwise ignored: the trace must never change what the client gets. */
  function recordTrace(event: TraceEvent): void {
    if (options.trace === undefined) return
    try {
      options.trace.record(event)
    } catch (err) {
      log.error(`transform proxy: trace sink failed: ${errorMessage(err)}`)
    }
  }

  /** Records this request's single response or error line; a no-op without a trace. */
  function recordReply(trace: RequestTrace | undefined, phase: 'response' | 'error', status: number, content: unknown): void {
    if (trace === undefined) return
    recordTrace({
      ...trace.base,
      at: new Date().toISOString(),
      phase,
      status,
      durationMs: Date.now() - trace.startedAt,
      content,
      leaks: [],
    })
  }

  async function buildInstance(state: SessionState, sessionId: string, pipelineId: string): Promise<Transform> {
    const stages: Transform[] = []
    const ids = pipelines[pipelineId] ?? []
    try {
      for (const id of ids) {
        const factory = factories.get(id)
        if (factory === undefined) throw new Error(`transform "${id}" is not configured`)
        try {
          stages.push(await factory({ sessionId, facts: state.facts.facts, log }))
        } catch (err) {
          throw new Error(`transform "${id}" failed to start: ${errorMessage(err)}`, { cause: err })
        }
      }
    } catch (err) {
      for (const stage of stages) {
        try {
          await stage.dispose?.()
        } catch (disposeErr) {
          log.error(`transform dispose failed: ${errorMessage(disposeErr)}`)
        }
      }
      throw err
    }
    const composed = composeTransforms(stages, log)
    stagesOf.set(composed, ids.map((id, i) => ({ id, transform: stages[i]! })))
    return composed
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://proxy.invalid')
    if (options.token !== undefined && !tokenMatches(header(req, TOKEN_HEADER), options.token)) {
      return sendError(res, 401, 'unauthorized', `${TOKEN_HEADER} is missing or wrong`)
    }
    if (req.method === 'OPTIONS') return sendError(res, 405, 'method_not_allowed', 'OPTIONS is refused')

    const upstreamValue = header(req, UPSTREAM_HEADER)
    if (upstreamValue === undefined) return sendError(res, 400, 'missing_upstream', `${UPSTREAM_HEADER} is required`)
    const upstream = parseHttpUrl(upstreamValue)
    if (upstream === undefined) return sendError(res, 400, 'invalid_upstream', `${UPSTREAM_HEADER} must be an http(s) URL`)
    if (!upstreamAllowed(upstream, allowed)) {
      return sendError(res, 403, 'upstream_not_allowed', `upstream ${upstream.origin} is not allowed`)
    }

    const sessionId = header(req, SESSION_HEADER) ?? DEFAULT_SESSION
    const pipelineId = header(req, PIPELINE_HEADER) ?? options.defaultPipeline
    if (pipelineId === undefined) return sendError(res, 400, 'no_pipeline', `${PIPELINE_HEADER} is required`)
    if (!Object.hasOwn(pipelines, pipelineId)) {
      return sendError(res, 400, 'unknown_pipeline', `pipeline "${pipelineId}" is not configured`)
    }

    const method = req.method ?? 'GET'
    const classified = classify(method, url.pathname)
    if (classified === undefined) {
      return sendError(res, 404, 'unsupported_route', `${method} ${url.pathname} is not proxied`)
    }

    const forwardPath = `${upstream.origin}${upstream.pathname.replace(/\/+$/, '')}${url.pathname}`
    const forwardTo = `${forwardPath}${url.search}`
    const headers = forwardRequestHeaders(req.headers)

    if (classified.kind === 'passthrough') {
      const upstreamRes = await fetchUpstream(res, forwardTo, method, headers, undefined)
      return relayUpstream(res, upstreamRes, undefined)
    }

    const { route } = classified
    const encoding = header(req, 'content-encoding')
    if (encoding !== undefined && encoding !== 'identity') {
      return sendError(res, 400, 'unsupported_encoding', 'request bodies must not be content-encoded')
    }
    const raw = await readBody(req)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      return sendError(res, 400, 'invalid_json', 'request body is not JSON')
    }

    const state = stateFor(sessionId)
    let instance: Transform
    try {
      instance = await instanceFor(state, pipelineId, () => buildInstance(state, sessionId, pipelineId))
    } catch (err) {
      return sendError(res, 502, 'transform_failed', errorMessage(err))
    }
    const ctx: WireContext = { transform: instance, signatures: state.signatures }

    let rewritten: unknown
    try {
      rewritten = await route.wire.request(parsed, ctx)
    } catch (err) {
      if (err instanceof UnsupportedContentError) return sendError(res, 400, 'unsupported_content', err.message)
      return sendError(res, 502, 'transform_failed', errorMessage(err))
    }

    // Always on, trace or not: warn with kind/source/path only, never the value, and never block the request.
    const leaks = findLeaks(rewritten, knownOriginals(state.facts.facts, instance))
    if (leaks.length > 0) log.warn('transform proxy: known original sent upstream', { sessionId, route: route.name, leaks })

    // Shared by this request's request/response/error trace lines; `startedAt` gives their durationMs.
    const trace =
      options.trace === undefined
        ? undefined
        : {
            startedAt: Date.now(),
            base: {
              requestId: randomUUID(),
              sessionId,
              pipeline: pipelineId,
              route: route.name,
              upstream: forwardPath,
              ...modelOf(rewritten),
            },
          }
    if (trace !== undefined) {
      recordTrace({
        ...trace.base,
        at: new Date(trace.startedAt).toISOString(),
        phase: 'request',
        content: requestDelta(rewritten, state.traced),
        leaks,
      })
    }

    const upstreamRes = await fetchUpstream(res, forwardTo, method, headers, JSON.stringify(rewritten), trace)
    return relayUpstream(res, upstreamRes, route.rewriteResponse ? { wire: route.wire, ctx } : undefined, trace)
  }

  async function fetchUpstream(
    res: ServerResponse,
    target: string,
    method: string,
    headers: Headers,
    body: string | undefined,
    trace?: RequestTrace,
  ): Promise<Response | undefined> {
    try {
      return await fetch(target, { method, headers, body, redirect: 'manual' })
    } catch (err) {
      recordReply(trace, 'error', 502, errorMessage(err))
      sendError(res, 502, 'upstream_unreachable', errorMessage(err))
      return undefined
    }
  }

  /**
   * Relays an upstream response. With `rewrite`, a 2xx JSON or SSE body is restored on the way back. With `trace`
   * (wire routes only), the reply before restore is recorded as exactly one response or error line.
   */
  async function relayUpstream(
    res: ServerResponse,
    upstreamRes: Response | undefined,
    rewrite: { readonly wire: WireWalker; readonly ctx: WireContext } | undefined,
    trace?: RequestTrace,
  ): Promise<void> {
    if (upstreamRes === undefined) return
    // Media types are case-insensitive (RFC 9110 §8.3.1).
    const contentType = (upstreamRes.headers.get('content-type') ?? '').toLowerCase()
    const headers = relayHeaders(upstreamRes.headers)

    if (trace !== undefined && !upstreamRes.ok) {
      // Read once: the same bytes go to the trace and, unchanged, to the client.
      const bytes = Buffer.from(await upstreamRes.arrayBuffer())
      recordReply(trace, 'error', upstreamRes.status, bytes.toString('utf8').slice(0, ERROR_TRACE_CHARS))
      res.writeHead(upstreamRes.status, headers)
      res.end(bytes)
      return
    }
    if (rewrite !== undefined && upstreamRes.ok && contentType.startsWith('text/event-stream')) {
      if (trace === undefined) return pipeStream(res, upstreamRes, headers, rewrite.wire.stream(rewrite.ctx), log)
      let observed = false
      const observe = (message: unknown): void => {
        observed = true
        recordReply(trace, 'response', upstreamRes.status, message)
      }
      await pipeStream(res, upstreamRes, headers, rewrite.wire.stream({ ...rewrite.ctx, observe }), log)
      // The stream ended before a complete reply (aborted, client gone): still one line per request.
      if (!observed) recordReply(trace, 'response', upstreamRes.status, undefined)
      return
    }
    if (upstreamRes.ok && contentType.includes('application/json') && (rewrite !== undefined || trace !== undefined)) {
      const bytes = Buffer.from(await upstreamRes.arrayBuffer())
      let body: unknown
      try {
        body = JSON.parse(new TextDecoder().decode(bytes))
      } catch (err) {
        recordReply(trace, 'error', 502, errorMessage(err))
        if (rewrite !== undefined) return sendError(res, 502, 'transform_failed', errorMessage(err))
        res.writeHead(upstreamRes.status, headers)
        res.end(bytes)
        return
      }
      // Before `wire.response`: the sink is synchronous, so it sees the reply as the provider sent it.
      recordReply(trace, 'response', upstreamRes.status, body)
      if (rewrite === undefined) {
        res.writeHead(upstreamRes.status, headers)
        res.end(bytes)
        return
      }
      let restored: string
      try {
        restored = JSON.stringify(rewrite.wire.response(body, rewrite.ctx))
      } catch (err) {
        return sendError(res, 502, 'transform_failed', errorMessage(err))
      }
      res.writeHead(upstreamRes.status, headers)
      res.end(restored)
      return
    }
    const bytes = Buffer.from(await upstreamRes.arrayBuffer())
    recordReply(trace, 'response', upstreamRes.status, undefined)
    res.writeHead(upstreamRes.status, headers)
    res.end(bytes)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error(`request failed: ${errorMessage(err)}`)
      sendError(res, 500, 'internal_error', 'transform proxy failed')
    })
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(options.port ?? 0, host, () => {
    server.off('error', listening.reject)
    listening.resolve()
  })
  await listening.promise
  const address = server.address() as AddressInfo
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`

  return {
    url,
    session(id: string) {
      const state = stateFor(id)
      return { facts: state.facts.facts, publisher: (source: string) => state.facts.publisher(source) }
    },
    async dropSession(id: string) {
      const state = sessions.get(id)
      if (state === undefined) return
      sessions.delete(id)
      await disposeInstances(state, log)
    },
    async inspect(sessionId: string, pipelineId?: string) {
      const state = sessions.get(sessionId)
      const pipeline = pipelineId ?? options.defaultPipeline
      if (state === undefined || pipeline === undefined) return {}
      const pending = state.instances.get(pipeline)
      if (pending === undefined) return {}
      let instance: Transform
      try {
        instance = await pending
      } catch {
        return {}
      }
      const result: Record<string, unknown> = {}
      for (const stage of stagesOf.get(instance) ?? []) {
        if (typeof stage.transform.inspect === 'function') result[stage.id] = stage.transform.inspect()
      }
      return result
    },
    async close() {
      const closed = Promise.withResolvers<void>()
      server.close((err) => (err ? closed.reject(err) : closed.resolve()))
      server.closeAllConnections()
      await closed.promise
      for (const id of [...sessions.keys()]) {
        const state = sessions.get(id)
        sessions.delete(id)
        if (state !== undefined) await disposeInstances(state, log)
      }
    },
  }
}

function validatePipelines(options: TransformProxyOptions): void {
  for (const [pipelineId, ids] of Object.entries(options.pipelines)) {
    for (const id of ids) {
      if (!Object.hasOwn(options.transforms, id)) throw new Error(`pipeline "${pipelineId}" names unknown transform "${id}"`)
    }
  }
  if (options.defaultPipeline !== undefined && !Object.hasOwn(options.pipelines, options.defaultPipeline)) {
    throw new Error(`defaultPipeline "${options.defaultPipeline}" is not a configured pipeline`)
  }
}

/** `{ model }` when the request body names its model as a string, otherwise `{}`. */
function modelOf(body: unknown): { model?: string } {
  if (typeof body !== 'object' || body === null) return {}
  const model = (body as { model?: unknown }).model
  return typeof model === 'string' ? { model } : {}
}

function originOf(value: string): string {
  const url = parseHttpUrl(value)
  if (url === undefined) throw new Error(`allowUpstreams entry "${value}" is not an http(s) URL`)
  return url.origin
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

function upstreamAllowed(url: URL, allowed: ReadonlySet<string> | undefined): boolean {
  if (allowed !== undefined) return allowed.has(url.origin)
  return url.protocol === 'https:' || (url.protocol === 'http:' && Object.hasOwn(LOOPBACK_HOSTS, url.hostname))
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  const first = Array.isArray(value) ? value[0] : value
  return first === undefined || first === '' ? undefined : first
}

function forwardRequestHeaders(incoming: IncomingHttpHeaders): Headers {
  const out = new Headers()
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || name.startsWith('x-skaile-transform-') || Object.hasOwn(REQUEST_SKIP, name)) continue
    for (const item of Array.isArray(value) ? value : [value]) out.append(name, item)
  }
  // Upstream bodies are read as text; identity keeps them decodable and makes rewriting safe.
  out.set('accept-encoding', 'identity')
  return out
}

function relayHeaders(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  headers.forEach((value, name) => {
    if (!Object.hasOwn(RESPONSE_SKIP, name)) out[name] = value
  })
  const cookies = headers.getSetCookie()
  if (cookies.length > 0) out['set-cookie'] = cookies
  return out
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  return Buffer.concat(chunks)
}

/** Streams an SSE body through the transformer, chunk by chunk, decoding UTF-8 across chunk boundaries. */
async function pipeStream(
  res: ServerResponse,
  upstreamRes: Response,
  headers: Record<string, string | string[]>,
  transformer: SseTransformer,
  log: Logger,
): Promise<void> {
  res.writeHead(upstreamRes.status, headers)
  const reader = upstreamRes.body?.getReader()
  if (reader === undefined) {
    res.end()
    return
  }
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await writeText(res, transformer.push(decoder.decode(value, { stream: true })))
      if (res.destroyed) {
        await reader.cancel()
        return
      }
    }
    await writeText(res, transformer.push(decoder.decode()) + transformer.flush())
    res.end()
  } catch (err) {
    log.error(`stream relay failed: ${errorMessage(err)}`)
    res.destroy()
  }
}

function writeText(res: ServerResponse, text: string): Promise<void> {
  if (text === '' || res.write(text)) return Promise.resolve()
  const drained = Promise.withResolvers<void>()
  const done = (): void => {
    res.off('drain', done)
    res.off('close', done)
    drained.resolve()
  }
  res.once('drain', done)
  res.once('close', done)
  return drained.promise
}

/** Writes the error envelope `{ error: { type, message } }`. */
function sendError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { type, message } }))
}
