/**
 * The published views of the outbox, checked for the one property they exist
 * for: **identity moves only when contents move.**
 *
 * Without it every subscriber re-renders on every transition of an outage, and
 * the README's persistence recipe (`watch` the pending set, write it to
 * storage) would fire once per retry rather than once per change.
 */
import { describe, expect, it } from 'vitest'
import { createOutbox } from './src/outbox'
import { createSnapshot } from './src/snapshot'

const setup = () => {
  const outbox = createOutbox<string>({ retryDelay: () => 1000 })
  const snapshot = createSnapshot(outbox)
  return { outbox, snapshot, refresh: (now = 0) => snapshot.refresh(now) }
}

describe('before anything happens', () => {
  it('starts empty and not syncing', () => {
    const { snapshot } = setup()

    expect(snapshot.pending).toEqual([])
    expect(snapshot.inFlight).toEqual([])
    expect(snapshot.failed).toEqual([])
    expect(snapshot.isSyncing).toBe(false)
  })
})

describe('identity', () => {
  it('keeps an array while its contents do not change', () => {
    const { outbox, snapshot, refresh } = setup()

    outbox.set('A1', 'a')
    refresh()
    const pending = snapshot.pending

    outbox.set('A1', 'a-again')
    refresh()

    expect(snapshot.pending).toBe(pending)
  })

  it('replaces it when a key joins or leaves', () => {
    const { outbox, snapshot, refresh } = setup()

    outbox.set('A1', 'a')
    refresh()
    const first = snapshot.pending

    outbox.set('B2', 'b')
    refresh()
    expect(snapshot.pending).not.toBe(first)
    expect(snapshot.pending).toEqual(['A1', 'B2'])

    const second = snapshot.pending
    outbox.discard('A1')
    refresh()
    expect(snapshot.pending).not.toBe(second)
    expect(snapshot.pending).toEqual(['B2'])
  })

  it('keeps the failure list while the same error repeats identically', () => {
    const { outbox, snapshot, refresh } = setup()
    const error = new Error('503')

    outbox.set('A1', 'a')
    const [sent] = outbox.take(0)
    outbox.fail('A1', sent!.sentVersion, error, 0)
    refresh(0)
    const failed = snapshot.failed

    // Nothing about the key moved, so a second look must not rebuild the list.
    refresh(0)
    expect(snapshot.failed).toBe(failed)
  })

  it('replaces the failure list when the attempt count moves', () => {
    const { outbox, snapshot, refresh } = setup()
    const error = new Error('503')

    outbox.set('A1', 'a')
    const first = outbox.take(0)
    outbox.fail('A1', first[0]!.sentVersion, error, 0)
    refresh(0)
    const failed = snapshot.failed

    const second = outbox.take(5000)
    outbox.fail('A1', second[0]!.sentVersion, error, 5000)
    refresh(5000)

    expect(snapshot.failed).not.toBe(failed)
    expect(snapshot.failed[0]?.attempts).toBe(2)
  })
})

describe('isSyncing', () => {
  it('follows the in-flight set', () => {
    const { outbox, snapshot, refresh } = setup()

    outbox.set('A1', 'a')
    refresh()
    expect(snapshot.isSyncing).toBe(false)

    const [sent] = outbox.take(0)
    refresh()
    expect(snapshot.inFlight).toEqual(['A1'])
    expect(snapshot.isSyncing).toBe(true)

    outbox.settle('A1', sent!.sentVersion)
    refresh()
    expect(snapshot.isSyncing).toBe(false)
  })
})

describe('retryAt', () => {
  it('is clamped to the reading it was refreshed with, never the past', () => {
    const { outbox, snapshot, refresh } = setup()

    outbox.set('A1', 'a')
    const [sent] = outbox.take(0)
    outbox.fail('A1', sent!.sentVersion, new Error('503'), 0)

    refresh(0)
    expect(snapshot.failed[0]?.retryAt).toBe(1000)

    // The deadline has passed; the countdown must not go negative.
    refresh(9000)
    expect(snapshot.failed[0]?.retryAt).toBe(9000)
  })
})
