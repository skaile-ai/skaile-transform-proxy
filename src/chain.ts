import type { Logger, TextLeaf, Transform } from './contract.ts'
import { errorMessage, silentLogger } from './log.ts'

/** One stage's streamed inbound transformer, as returned by `Transform.inboundStream()`. */
export interface InboundStream {
  push(chunk: string): string
  flush(): string
}

/**
 * Composes the stages of one pipeline into a single transform.
 * Outbound runs stage 1 to n, inbound and streamed inbound run stage n to 1.
 * The empty list is the identity.
 */
export function composeTransforms(stages: readonly Transform[], log: Logger = silentLogger): Transform {
  const instructions = stages.flatMap((stage) => (stage.instruction === undefined ? [] : [stage.instruction]))
  const reversed = [...stages].reverse()
  return {
    ...(instructions.length > 0 ? { instruction: instructions.join('\n\n') } : {}),
    async outbound(text: string, leaf: TextLeaf): Promise<string> {
      let out = text
      for (const stage of stages) out = await stage.outbound(out, leaf)
      return out
    },
    inbound(text: string): string {
      let out = text
      for (const stage of reversed) out = stage.inbound(out)
      return out
    },
    inboundStream(): InboundStream {
      return composeStreams(stages.map((stage) => stage.inboundStream()))
    },
    async dispose(): Promise<void> {
      for (const stage of stages) {
        try {
          await stage.dispose?.()
        } catch (err) {
          log.error(`transform dispose failed: ${errorMessage(err)}`)
        }
      }
    },
  }
}

/**
 * Streams stage by stage. `streams` is in pipeline order (stage 1 first).
 * push feeds stage n first and passes each result down to stage 1.
 * flush goes n to 1: each stage's tail is pushed through the stages below it.
 */
function composeStreams(streams: readonly InboundStream[]): InboundStream {
  const reversed = [...streams].reverse()
  return {
    push(chunk: string): string {
      let out = chunk
      for (const stream of reversed) out = stream.push(out)
      return out
    },
    flush(): string {
      let carry = ''
      for (const stream of reversed) {
        const pushed = carry === '' ? '' : stream.push(carry)
        carry = pushed + stream.flush()
      }
      return carry
    },
  }
}
