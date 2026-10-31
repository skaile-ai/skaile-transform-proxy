import type { SessionFact, SessionFactPublisher, SessionFacts } from './contract.ts'

/** One session's facts: the read side for transforms and the per-source publishers for connectors. */
export interface SessionFactStore {
  readonly facts: SessionFacts
  publisher(source: string): SessionFactPublisher
}

export function createSessionFacts(): SessionFactStore {
  const bySource = new Map<string, readonly SessionFact[]>()
  let version = 0
  return {
    facts: {
      get version() {
        return version
      },
      list(kind?: string): readonly SessionFact[] {
        const all: SessionFact[] = []
        for (const facts of bySource.values()) {
          for (const fact of facts) if (kind === undefined || fact.kind === kind) all.push(fact)
        }
        return all
      },
    },
    publisher(source: string): SessionFactPublisher {
      return {
        publish(facts) {
          bySource.set(
            source,
            facts.map((fact) => ({ kind: fact.kind, value: fact.value, source })),
          )
          version++
        },
        clear() {
          bySource.delete(source)
          version++
        },
      }
    },
  }
}
