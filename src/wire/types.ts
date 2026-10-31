// The seam between the HTTP server and the per-protocol wire walkers.

import type { Transform } from '../contract.ts'

export interface WireContext {
  /** The session's composed pipeline. */
  readonly transform: Transform
  /**
   * Session-scoped cache of signed reasoning: key -> text exactly as the model produced it.
   * Walkers namespace their keys (`anthropic:<signature>`, `responses:<itemId>`).
   */
  readonly signatures: Map<string, string>
}

/** Thrown by `request` for attachments (image, document, file parts); the server answers 400 `unsupported_content`. */
export class UnsupportedContentError extends Error {
  readonly code = 'unsupported_content'
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedContentError'
  }
}

/** A text transformer over raw SSE text; safe at any chunk boundary. */
export interface SseTransformer {
  push(chunk: string): string
  flush(): string
}

/** Pure functions over one wire protocol's parsed JSON. */
export interface WireWalker {
  /**
   * Returns the request body with every text leaf passed through `outbound` and the
   * pipeline `instruction` added to the system prompt. Throws `UnsupportedContentError`
   * for attachments; `outbound` errors propagate unchanged.
   */
  request(body: unknown, ctx: WireContext): Promise<unknown>
  /** Restores a non-streamed JSON response. */
  response(body: unknown, ctx: WireContext): unknown
  /** SSE event transformer for a streamed response. */
  stream(ctx: WireContext): SseTransformer
}
