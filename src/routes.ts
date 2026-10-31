import { anthropicWalker } from './wire/anthropic.ts'
import { openaiChatWalker } from './wire/openai-chat.ts'
import { openaiResponsesWalker } from './wire/openai-responses.ts'
import type { WireWalker } from './wire/types.ts'

/** A POST route: the path suffix it matches, the walker that rewrites the request, and whether the response is rewritten too. */
export interface WireRoute {
  readonly suffix: string
  readonly wire: WireWalker
  readonly rewriteResponse: boolean
}

/**
 * The route table. Routes are matched in order, so longer suffixes come first.
 * Any other path, embeddings included, answers 404 `unsupported_route`.
 */
export const WIRE_ROUTES: readonly WireRoute[] = [
  { suffix: '/messages/count_tokens', wire: anthropicWalker, rewriteResponse: false },
  { suffix: '/messages', wire: anthropicWalker, rewriteResponse: true },
  { suffix: '/chat/completions', wire: openaiChatWalker, rewriteResponse: true },
  { suffix: '/responses', wire: openaiResponsesWalker, rewriteResponse: true },
]

export type Classified = { readonly kind: 'wire'; readonly route: WireRoute } | { readonly kind: 'passthrough' }

/** Classifies a request by method and path. `undefined` means the route is unsupported. */
export function classify(method: string, pathname: string): Classified | undefined {
  if (method === 'GET' && pathname.endsWith('/models')) return { kind: 'passthrough' }
  if (method !== 'POST') return undefined
  const route = WIRE_ROUTES.find((candidate) => pathname.endsWith(candidate.suffix))
  return route === undefined ? undefined : { kind: 'wire', route }
}
