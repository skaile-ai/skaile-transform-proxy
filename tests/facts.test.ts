import { describe, expect, test } from 'bun:test'
import { createSessionFacts } from '../src/facts.ts'

describe('session facts', () => {
  test('a new session has no facts and version 0', () => {
    const store = createSessionFacts()
    expect(store.facts.version).toBe(0)
    expect(store.facts.list()).toEqual([])
  })

  test('publish records facts under the publisher id and bumps the version', () => {
    const store = createSessionFacts()
    store.publisher('conn.patients').publish([
      { kind: 'NAME_PATIENT', value: 'Alice' },
      { kind: 'DATE_BIRTH', value: '1970-01-01' },
    ])
    expect(store.facts.version).toBe(1)
    expect(store.facts.list()).toEqual([
      { kind: 'NAME_PATIENT', value: 'Alice', source: 'conn.patients' },
      { kind: 'DATE_BIRTH', value: '1970-01-01', source: 'conn.patients' },
    ])
  })

  test('a second publish replaces the same publisher facts, not appends', () => {
    const store = createSessionFacts()
    const publisher = store.publisher('conn.patients')
    publisher.publish([{ kind: 'NAME_PATIENT', value: 'Alice' }])
    publisher.publish([{ kind: 'NAME_PATIENT', value: 'Bob' }])
    expect(store.facts.version).toBe(2)
    expect(store.facts.list()).toEqual([{ kind: 'NAME_PATIENT', value: 'Bob', source: 'conn.patients' }])
  })

  test('replacing one publisher keeps the facts of other publishers', () => {
    const store = createSessionFacts()
    store.publisher('a').publish([{ kind: 'NAME_PATIENT', value: 'Alice' }])
    store.publisher('b').publish([{ kind: 'NAME_PATIENT', value: 'Bob' }])
    store.publisher('a').publish([])
    expect(store.facts.list()).toEqual([{ kind: 'NAME_PATIENT', value: 'Bob', source: 'b' }])
  })

  test('clear removes only that publisher facts and bumps the version', () => {
    const store = createSessionFacts()
    store.publisher('a').publish([{ kind: 'NAME_PATIENT', value: 'Alice' }])
    store.publisher('b').publish([{ kind: 'NAME_PATIENT', value: 'Bob' }])
    const before = store.facts.version
    store.publisher('a').clear()
    expect(store.facts.version).toBe(before + 1)
    expect(store.facts.list()).toEqual([{ kind: 'NAME_PATIENT', value: 'Bob', source: 'b' }])
  })

  test('list filters by kind', () => {
    const store = createSessionFacts()
    store.publisher('a').publish([
      { kind: 'NAME_PATIENT', value: 'Alice' },
      { kind: 'DATE_BIRTH', value: '1970-01-01' },
    ])
    expect(store.facts.list('DATE_BIRTH')).toEqual([{ kind: 'DATE_BIRTH', value: '1970-01-01', source: 'a' }])
    expect(store.facts.list('CITY')).toEqual([])
  })

  test('the version changes on every write, so readers can skip unchanged reads', () => {
    const store = createSessionFacts()
    const seen: number[] = []
    const publisher = store.publisher('a')
    publisher.publish([{ kind: 'NAME_PATIENT', value: 'Alice' }])
    seen.push(store.facts.version)
    publisher.clear()
    seen.push(store.facts.version)
    expect(seen).toEqual([1, 2])
  })
})
