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
