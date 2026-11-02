// The transform contract: what a pipeline stage is, what it sees, and how a transform module is loaded.

/** Minimal logger; structurally compatible with the workspaces `Logger`. */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

export type TextLeafKind = 'system' | 'user' | 'assistant' | 'thinking' | 'toolCall' | 'toolResult'
export interface TextLeaf {
  readonly kind: TextLeafKind
  readonly toolName?: string
}

/** One session's instance of one pipeline stage. */
export interface Transform {
  /** Added to the system prompt by each wire walker (Anthropic: appended last; OpenAI: placed first); omit when the model needs no instruction. */
  readonly instruction?: string
  /** Host -> model, one text leaf. A throw refuses the request (502 `transform_failed`); nothing is sent. */
  outbound(text: string, leaf: TextLeaf): Promise<string>
  /** Model -> host, one complete text. */
  inbound(text: string): string
  /** Model -> host, one streamed text block. Invariant: push(c1)+...+push(cn)+flush() === inbound(c1+...+cn). */
  inboundStream(): { push(chunk: string): string; flush(): string }
  /** Called once when the proxy drops the session. */
  dispose?(): void | Promise<void>
  /** Host-only state of this instance (e.g. the anon mapping), read through TransformProxy.inspect. Never called by the walkers, never sent anywhere. */
  inspect?(): unknown
  /**
   * Originals this instance has already replaced in this session (forge-anon: its mapping), each with its kind.
   * Used only by the proxy's leak check, which reports kind and JSON path, never the value; never sent anywhere.
   */
  knownOriginals?(): Iterable<{ readonly kind: string; readonly value: string }>
}

export interface SessionFact {
  readonly kind: string
  readonly value: string
  readonly source: string
}
export interface SessionFacts {
  /** Bumped on every publish/clear; readers re-read `list()` only when it changed. */
  readonly version: number
  list(kind?: string): readonly SessionFact[]
}
export interface SessionFactPublisher {
  /** Replaces this publisher's facts (source = publisher id). */
  publish(facts: readonly Omit<SessionFact, 'source'>[]): void
  clear(): void
}

export interface TransformSessionContext {
  readonly sessionId: string
  readonly facts: SessionFacts
  readonly log: Logger
}
export type TransformFactory = (ctx: TransformSessionContext) => Promise<Transform>

/** Default export of a transform module, e.g. `@skaile/forge-anon/proxy`. */
export interface TransformModule {
  readonly id: string
  /** Once per proxy and config: validate config, build shared heavy state (detectors). Throws on a bad config. */
  open(config: unknown, ctx: { readonly baseDir: string; readonly log: Logger }): Promise<TransformFactory>
}

/** One leak-check finding. Never carries the value itself. */
export interface TraceLeak {
  /** Fact/original kind, e.g. 'person'. */
  readonly kind: string
  /** Fact source (publisher id), or 'pipeline' for `Transform.knownOriginals`. */
  readonly source: string
  /** JSON path in the rewritten request body, e.g. 'tools[0].description'. */
  readonly at: string
}

/** One line of the anon trace: what left for the provider (request) or what it answered before restore (response/error). */
export interface TraceEvent {
  /** ISO timestamp. */
  readonly at: string
  /** Per proxied request; links its request/response/error lines. */
  readonly requestId: string
  readonly sessionId: string
  readonly pipeline: string
  /** `WireRoute.name`, e.g. 'anthropic.messages'. */
  readonly route: string
  /** Forward target origin + path, no query string. */
  readonly upstream: string
  /** Request body `model` when a string. */
  readonly model?: string
  readonly phase: 'request' | 'response' | 'error'
  /** response/error: HTTP status (502 when the upstream was unreachable). */
  readonly status?: number
  /** response/error: ms since the request event. */
  readonly durationMs?: number
  /**
   * request: the delta, keyed by JSON path (`{ 'messages[4]': {...}, system: [...] }`), only entries not yet traced in
   * this session; `{}` when nothing is new.
   * response: the model reply before restore (streamed: assembled in the protocol's non-streamed shape; `undefined` when
   * the stream ended before a complete reply).
   * error: the upstream error body as text, cut to 4096 chars, or the fetch error message.
   */
  readonly content?: unknown
  /** Set only by `serializeTraceEvent`. */
  readonly truncated?: boolean
  /** request: leak-check findings; response/error: []. */
  readonly leaks: readonly TraceLeak[]
}

/** Synchronous. The proxy catches a throw, logs it, and never lets it reach the client. */
export interface TraceSink {
  record(event: TraceEvent): void
}
