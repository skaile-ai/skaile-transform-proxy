import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { composeTransforms } from './chain.ts'
import type { Logger, SessionFactPublisher, SessionFacts, Transform } from './contract.ts'
import { errorMessage, silentLogger } from './log.ts'
import { openTransforms, type TransformSpec } from './modules.ts'
import { classify } from './routes.ts'
import { createSessionState, disposeInstances, instanceFor, type SessionState } from './sessions.ts'
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
}

export interface TransformProxy {
  readonly url: string
  session(id: string): { readonly facts: SessionFacts; publisher(source: string): SessionFactPublisher }
  /** Disposes the session's transform instances and forgets its facts and caches. */
  dropSession(id: string): Promise<void>
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

  function stateFor(id: string): SessionState {
    const existing = sessions.get(id)
    if (existing) return existing
    const created = createSessionState()
    sessions.set(id, created)
    return created
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
    return composeTransforms(stages, log)
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

    const forwardTo = `${upstream.origin}${upstream.pathname.replace(/\/+$/, '')}${url.pathname}${url.search}`
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

    const upstreamRes = await fetchUpstream(res, forwardTo, method, headers, JSON.stringify(rewritten))
    return relayUpstream(res, upstreamRes, route.rewriteResponse ? { wire: route.wire, ctx } : undefined)
  }

  async function fetchUpstream(
    res: ServerResponse,
    target: string,
    method: string,
    headers: Headers,
    body: string | undefined,
  ): Promise<Response | undefined> {
    try {
      return await fetch(target, { method, headers, body, redirect: 'manual' })
    } catch (err) {
      sendError(res, 502, 'upstream_unreachable', errorMessage(err))
      return undefined
    }
  }

  /** Relays an upstream response. With `rewrite`, a 2xx JSON or SSE body is restored on the way back. */
  async function relayUpstream(
    res: ServerResponse,
    upstreamRes: Response | undefined,
    rewrite: { readonly wire: WireWalker; readonly ctx: WireContext } | undefined,
  ): Promise<void> {
    if (upstreamRes === undefined) return
    const contentType = upstreamRes.headers.get('content-type') ?? ''
    const headers = relayHeaders(upstreamRes.headers)

    if (rewrite !== undefined && upstreamRes.ok && contentType.startsWith('text/event-stream')) {
      return pipeStream(res, upstreamRes, headers, rewrite.wire.stream(rewrite.ctx), log)
    }
    if (rewrite !== undefined && upstreamRes.ok && contentType.includes('application/json')) {
      const text = await upstreamRes.text()
      let restored: string
      try {
        restored = JSON.stringify(rewrite.wire.response(JSON.parse(text), rewrite.ctx))
      } catch (err) {
        return sendError(res, 502, 'transform_failed', errorMessage(err))
      }
      res.writeHead(upstreamRes.status, headers)
      res.end(restored)
      return
    }
    res.writeHead(upstreamRes.status, headers)
    res.end(Buffer.from(await upstreamRes.arrayBuffer()))
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
