import { describe, expect, test } from 'bun:test'
import { composeTransforms, type Logger, type TextLeaf, type Transform } from '../src/index.ts'
import { replacer, seededRandom, splitAt } from './support.ts'

/** Records calls and tags the text, so the order of stages is visible in the result. */
function labelled(label: string, calls: string[]): Transform {
  return {
    async outbound(text: string, leaf: TextLeaf): Promise<string> {
      calls.push(`out:${label}:${leaf.kind}`)
      return `${text}+${label}`
    },
    inbound(text: string): string {
      calls.push(`in:${label}`)
      return `${text}-${label}`
    },
    inboundStream() {
      return { push: (chunk: string) => chunk, flush: () => '' }
    },
  }
}

describe('composeTransforms', () => {
  test('the empty chain is the identity', async () => {
    const identity = composeTransforms([])
    expect(identity.instruction).toBeUndefined()
    expect(await identity.outbound('Alice', { kind: 'user' })).toBe('Alice')
    expect(identity.inbound('Alice')).toBe('Alice')
    const stream = identity.inboundStream()
    expect(stream.push('a') + stream.push('b') + stream.flush()).toBe('ab')
  })

  test('outbound runs stage 1 to n, every stage with the same leaf', async () => {
    const calls: string[] = []
    const chain = composeTransforms([labelled('a', calls), labelled('b', calls)])
    expect(await chain.outbound('x', { kind: 'toolResult', toolName: 'search' })).toBe('x+a+b')
    expect(calls).toEqual(['out:a:toolResult', 'out:b:toolResult'])
  })

  test('inbound runs stage n to 1', () => {
    const calls: string[] = []
    const chain = composeTransforms([labelled('a', calls), labelled('b', calls)])
    expect(chain.inbound('x')).toBe('x-b-a')
    expect(calls).toEqual(['in:b', 'in:a'])
  })

  test('instructions join with a blank line, skipping stages without one', () => {
    expect(composeTransforms([replacer({ instruction: 'A' }), replacer(), replacer({ instruction: 'B' })]).instruction).toBe(
      'A\n\nB',
    )
    expect(composeTransforms([replacer()]).instruction).toBeUndefined()
  })

  test('dispose calls every stage, logs failures and does not rethrow', async () => {
    const disposed: string[] = []
    const errors: string[] = []
    const log: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: (msg: string) => {
        errors.push(msg)
      },
    }
    const failing: Transform = {
      ...replacer(),
      dispose() {
        disposed.push('a')
        throw new Error('boom')
      },
    }
    const healthy: Transform = {
      ...replacer(),
      dispose() {
        disposed.push('b')
      },
    }
    await composeTransforms([failing, healthy], log).dispose?.()
    expect([...disposed].sort()).toEqual(['a', 'b'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('boom')
  })

  test('a stage that holds a tail: the tail is flushed through the stages below it', () => {
    // Stage 2 (inbound first) turns "Ali" into "P1"; stage 1 turns "P1" into "Alice".
    const chain = composeTransforms([replacer({ inbound: { P1: 'Alice' } }), replacer({ inbound: { Ali: 'P1' } })])
    const stream = chain.inboundStream()
    let got = ''
    for (const piece of ['xAl', 'i']) got += stream.push(piece)
    got += stream.flush()
    expect(got).toBe('xAlice')
    expect(chain.inbound('xAli')).toBe('xAlice')
  })

  test('streamed inbound equals whole-text inbound for random chunkings of a two-stage chain', () => {
    const chain = composeTransforms([replacer({ inbound: { P1: 'Alice' } }), replacer({ inbound: { Ali: 'P1' } })])
    const rng = seededRandom(7)
    const alphabet = 'xAlPi1 '
    for (let run = 0; run < 400; run++) {
      const length = Math.floor(rng() * 24)
      let text = ''
      for (let i = 0; i < length; i++) text += alphabet.charAt(Math.floor(rng() * alphabet.length))
      const cuts = Array.from({ length: Math.floor(rng() * 6) }, () => Math.floor(rng() * (text.length + 1))).sort(
        (a, b) => a - b,
      )
      const stream = chain.inboundStream()
      let got = ''
      for (const piece of splitAt(text, cuts)) got += stream.push(piece)
      got += stream.flush()
      expect(got).toBe(chain.inbound(text))
    }
  })
})
