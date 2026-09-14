/**
 * The shadow map on its own — no outbox, no clock, no network.
 *
 * Every one of these used to be reachable only through the Vue composable,
 * which is a lot of machinery to stand up in order to ask "did this key move?".
 */
import { describe, expect, it } from 'vitest'
import { createShadow, type ShadowConfig } from './src/shadow'

const shadowOf = <T,>(
  record: Record<string, T>,
  overrides: Partial<Omit<ShadowConfig<T>, 'read'>> = {},
) =>
  createShadow<T>({
    read: () => record,
    tracked: overrides.tracked ?? (() => true),
    equals: overrides.equals ?? Object.is,
  })

describe('seeding', () => {
  it('records what the record starts with instead of reporting it', () => {
    const record = { A1: 'from-the-server', B2: 'also' }
    const shadow = shadowOf(record)

    expect(shadow.changes()).toEqual([])
  })

  it('reports a key added after construction', () => {
    const record: Record<string, string> = { A1: 'from-the-server' }
    const shadow = shadowOf(record)

    record.B2 = 'new'

    expect(shadow.changes()).toEqual([['B2', 'new']])
  })

  it('does not seed a key the filter excludes', () => {
    const record = { A1: 'a', B2: 'b' }
    let tracked = false
    const shadow = createShadow<string>({
      read: () => record,
      tracked: () => tracked,
      equals: Object.is,
    })

    // Nothing was seeded, so switching the filter on makes every key an edit.
    tracked = true
    expect(shadow.changes()).toEqual([
      ['A1', 'a'],
      ['B2', 'b'],
    ])
  })
})

describe('changes()', () => {
  it('reports each move exactly once', () => {
    const record: Record<string, string> = { A1: 'a' }
    const shadow = shadowOf(record)

    record.A1 = 'edited'
    expect(shadow.changes()).toEqual([['A1', 'edited']])
    expect(shadow.changes()).toEqual([])
    expect(shadow.changes()).toEqual([])
  })

  it('treats an undefined value as a value, not as an absent key', () => {
    const record: Record<string, string | undefined> = { A1: undefined }
    const shadow = shadowOf(record)

    expect(shadow.changes()).toEqual([])

    record.A1 = 'now-set'
    expect(shadow.changes()).toEqual([['A1', 'now-set']])
  })

  it('honours a custom equals', () => {
    const record: Record<string, string> = { A1: 'foo' }
    const shadow = shadowOf(record, { equals: (a, b) => a.toLowerCase() === b.toLowerCase() })

    record.A1 = 'FOO'
    expect(shadow.changes()).toEqual([])

    record.A1 = 'bar'
    expect(shadow.changes()).toEqual([['A1', 'bar']])
  })

  it('skips keys the filter excludes, in both forms', () => {
    const record: Record<string, string> = { A1: 'a', B2: 'b', 'draft:1': 'c' }
    const allowList = ['A1']
    const byList = shadowOf(record, { tracked: (key) => allowList.includes(key) })
    const byPredicate = shadowOf(record, { tracked: (key) => key.startsWith('draft:') })

    record.A1 = 'a2'
    record.B2 = 'b2'
    record['draft:1'] = 'c2'

    expect(byList.changes()).toEqual([['A1', 'a2']])
    expect(byPredicate.changes()).toEqual([['draft:1', 'c2']])
  })

  it('re-reads the record every time, so the object itself can be replaced', () => {
    let record: Record<string, string> = { A1: 'a' }
    const shadow = createShadow<string>({
      read: () => record,
      tracked: () => true,
      equals: Object.is,
    })

    record = { A1: 'a', B2: 'b' }

    expect(shadow.changes()).toEqual([['B2', 'b']])
  })

  it('forgets a deleted key, so putting it back is an edit again', () => {
    const record: Record<string, string> = { A1: 'a' }
    const shadow = shadowOf(record)

    delete record.A1
    expect(shadow.changes()).toEqual([])

    record.A1 = 'a'
    expect(shadow.changes()).toEqual([['A1', 'a']])
  })
})

describe('record()', () => {
  it('marks a value seen without reporting it', () => {
    const record: Record<string, string> = { A1: 'a' }
    const shadow = shadowOf(record)

    record.A1 = 'set-through'
    shadow.record('A1', 'set-through')

    expect(shadow.changes()).toEqual([])
  })

  it('marks a key the filter excludes, which is what set() needs', () => {
    const record: Record<string, string> = { A1: 'a', B2: 'b' }
    const shadow = shadowOf(record, { tracked: (key) => key === 'A1' })

    record.B2 = 'set-through'
    shadow.record('B2', 'set-through')

    expect(shadow.changes()).toEqual([])
  })
})
