/**
 * The correctness core. No timers and no I/O — every clock reading is a
 * number passed in, so these tests are fully deterministic.
 *
 * H1 (version guard), H3 (bounded + latest error only), H5 (reentrancy) all
 * live here; the engine-level suite only re-proves them end-to-end.
 */
import { describe, expect, it, vi } from 'vitest'
import { createOutbox } from './src/outbox'

const outbox = <T>(retryDelay: (attempts: number) => number | undefined = () => 1000) =>
  createOutbox<T>({ retryDelay })

describe('outbox — queueing', () => {
  it('coalesces N edits into one entry carrying the newest value', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.set('A1', 'b')
    box.set('A1', 'c')

    expect(box.pendingKeys()).toEqual(['A1'])
    const batch = box.take(0)
    expect(batch).toHaveLength(1)
    expect(batch[0]?.value).toBe('c')
  })

  it('keeps keys independent and in insertion order', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.set('B2', 'b')

    expect(box.take(0).map((e) => e.key)).toEqual(['A1', 'B2'])
  })

  it('is bounded by the number of keys, not the number of edits (H3)', () => {
    const box = outbox<number>()
    for (let i = 0; i < 500; i += 1) box.set('A1', i)

    expect(box.pendingKeys()).toHaveLength(1)
    expect(box.take(0)[0]?.value).toBe(499)
  })

  it('starts empty and reports no scheduled work', () => {
    const box = outbox<string>()
    expect(box.pendingKeys()).toEqual([])
    expect(box.hasWorkDueBy(0)).toBe(false)
    expect(box.take(0)).toEqual([])
  })
})

describe('outbox — reentrancy (H5)', () => {
  it('never hands out a key that is already in flight', () => {
    const box = outbox<string>()
    box.set('A1', 'a')

    expect(box.take(0)).toHaveLength(1)
    expect(box.take(0)).toEqual([])
  })

  it('still skips an in-flight key that has been edited since (H5 beats dirtiness)', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.set('A1', 'b')

    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.inFlightKeys()).toEqual(['A1'])
    expect(box.take(0)).toEqual([])
    expect(sent?.value).toBe('a')
  })

  it('reports nothing schedulable while every entry is in flight', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.take(0)

    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.hasWorkDueBy(0)).toBe(false)
  })
})

describe('outbox — flight identity outlives the entry (H5)', () => {
  /**
   * The 0.1.1 data-loss fix. `discard()` deletes the entry, and in 0.1.0 the
   * entry was the only record that a request was in the air — so the next
   * `set()` + `take()` opened a SECOND concurrent request for the same key and
   * the two could land out of order, leaving the server holding the older
   * value. A request cannot be recalled, so the key stays reserved until its
   * response lands.
   */
  it('refuses a key whose discarded flight is still in the air', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [first] = box.take(0)
    box.discard('A1')
    box.set('A1', 'b')

    expect(box.take(0)).toEqual([])

    box.settle('A1', first!.sentVersion) // the orphaned request finally lands
    expect(box.take(0)[0]?.value).toBe('b')
  })

  it('frees the key when the discarded flight fails, without recording a failure', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [first] = box.take(0)
    box.discard('A1')
    box.set('A1', 'b')

    box.fail('A1', first!.sentVersion, new Error('503'), 0)

    expect(box.failures(0)).toEqual([])
    expect(box.take(0)[0]?.value).toBe('b')
  })

  it('keeps the key reserved even when nothing replaced the discarded entry', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [first] = box.take(0)
    box.discard('A1')

    expect(box.pendingKeys()).toEqual([])
    expect(box.inFlightKeys()).toEqual([])

    box.set('A1', 'b')
    expect(box.take(0)).toEqual([]) // still on the wire
    box.settle('A1', first!.sentVersion)
    expect(box.take(0)).toHaveLength(1)
  })

  it('a forced take cannot open a second flight either', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.take(0)
    box.discard('A1')
    box.set('A1', 'b')

    expect(box.take(0, true)).toEqual([])
  })
})

describe('outbox — the version guard (H1)', () => {
  it('clears a key whose version did not move while its write was in flight', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)

    box.settle('A1', sent!.sentVersion)

    expect(box.pendingKeys()).toEqual([])
    expect(box.pendingKeys()).toEqual([])
  })

  it('does NOT clear a key edited while its own write was in flight', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.set('A1', 'b') // the edit a boolean dirty flag would lose

    box.settle('A1', sent!.sentVersion)

    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.inFlightKeys()).toEqual([])
    expect(box.take(0)[0]?.value).toBe('b')
  })

  it('ignores a response from a flight that is no longer current', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [first] = box.take(0)
    box.discard('A1')
    box.set('A1', 'b')

    // The discarded flight resolves late. It must not clear the new entry —
    // and it must not have been allowed to run alongside a second request
    // either, which is what `take` refusing the key above proves.
    box.settle('A1', first!.sentVersion)
    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.inFlightKeys()).toEqual([])

    const [second] = box.take(0)
    box.settle('A1', second!.sentVersion)
    expect(box.pendingKeys()).toEqual([])
  })

  it('gives every send a distinct version, even across discard', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [first] = box.take(0)
    box.discard('A1')
    box.set('A1', 'b')
    box.settle('A1', first!.sentVersion) // the discarded request lands, freeing the key
    const [second] = box.take(0)

    expect(second!.sentVersion).not.toBe(first!.sentVersion)
  })

  it('settling an unknown key is a no-op', () => {
    const box = outbox<string>()
    expect(() => box.settle('nope', 1)).not.toThrow()
    expect(box.pendingKeys()).toEqual([])
  })
})

describe('outbox — a response identifies its own flight', () => {
  it('a duplicate of an old response cannot free a key that is on the wire again', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [first] = box.take(0)
    box.settle('A1', first!.sentVersion)
    box.set('A1', 'b')
    const [second] = box.take(0)

    // A writer that answers twice (or a retried transport) must not be able to
    // clear the flight that is genuinely out.
    box.settle('A1', first!.sentVersion)
    expect(box.inFlightKeys()).toEqual(['A1'])
    expect(box.take(0)).toEqual([])

    box.settle('A1', second!.sentVersion)
    expect(box.pendingKeys()).toEqual([])
  })

  it('a duplicate failure cannot record a second attempt', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)

    box.fail('A1', sent!.sentVersion, new Error('boom'), 0)
    box.fail('A1', sent!.sentVersion, new Error('boom again'), 0)

    expect(box.failures(0)[0]?.attempts).toBe(1)
  })
})

describe('outbox — failure never clears (H1)', () => {
  it('keeps the key pending and records the error', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)

    box.fail('A1', sent!.sentVersion, new Error('boom'), 0)

    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.inFlightKeys()).toEqual([])
    expect(box.failures(0)).toEqual([
      { key: 'A1', error: expect.any(Error), attempts: 1, retryAt: 1000 },
    ])
  })

  it('re-sends the CURRENT value after a failure, not the one that failed', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.fail('A1', sent!.sentVersion, new Error('boom'), 0)
    box.set('A1', 'typed-since')

    expect(box.take(5000)[0]?.value).toBe('typed-since')
  })

  it('holds the key back until its backoff is due', () => {
    const box = outbox<string>((attempts) => attempts * 1000)
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.fail('A1', sent!.sentVersion, new Error('boom'), 500)

    expect(box.take(1000)).toEqual([]) // retryAt is 1500
    expect(box.take(1499)).toEqual([])
    expect(box.take(1500)).toHaveLength(1)
  })

  it('counts consecutive failures and keeps only the latest error (H3)', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('one'), 0)
    box.fail('A1', box.take(2000)[0]!.sentVersion, new Error('two'), 2000)

    const failures = box.failures(0)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.attempts).toBe(2)
    const latest = failures[0]?.error
    // `error` is `unknown` by design — narrow it rather than cast it.
    expect(latest).toBeInstanceOf(Error)
    expect(latest instanceof Error ? latest.message : undefined).toBe('two')
  })

  it('does not let a fresh edit shorten an active backoff', () => {
    const box = outbox<string>(() => 8000)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    box.set('A1', 'still-typing', 100)

    expect(box.take(100)).toEqual([])
    expect(box.take(8000)).toHaveLength(1)
  })

  it('clears the failure and the backoff once a write succeeds', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    box.set('A1', 'b')
    const [retry] = box.take(1000)
    box.settle('A1', retry!.sentVersion)

    expect(box.failures(0)).toEqual([])
    expect(box.pendingKeys()).toEqual([])
  })

  it('resets the attempt count when a success lands on a key that moved on', () => {
    const box = outbox<string>(() => 30000)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    // flush() sends the backed-off key anyway; the user types while it is out.
    const [forced] = box.take(0, true)
    box.set('A1', 'newer')
    box.settle('A1', forced!.sentVersion)

    expect(box.failures(1)).toEqual([])
    // Due immediately: the 30s backoff the failure scheduled is gone, because
    // the server has just proved it is answering.
    expect(box.take(1)).toHaveLength(1)
  })

  it('ignores a failure from a flight that is no longer current', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [first] = box.take(0)
    box.discard('A1')
    box.set('A1', 'b')

    box.fail('A1', first!.sentVersion, new Error('late'), 0)

    expect(box.failures(0)).toEqual([])
    expect(box.take(0)).toHaveLength(1)
  })
})

describe('outbox — retry disabled', () => {
  it('blocks the key instead of dropping it', () => {
    const box = outbox<string>(() => undefined)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)

    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.take(Number.POSITIVE_INFINITY)).toEqual([])
    expect(box.hasWorkDueBy(0)).toBe(false)
    expect(box.failures(0)[0]?.retryAt).toBeUndefined()
  })

  it('re-arms on a fresh edit — a new value is a new write, not a retry', () => {
    const box = outbox<string>(() => undefined)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    box.set('A1', 'b')

    expect(box.take(0)[0]?.value).toBe('b')
  })

  it('re-arms on clearBackoff', () => {
    const box = outbox<string>(() => undefined)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    box.clearBackoff('A1')

    expect(box.failures(0)).toEqual([])
    expect(box.take(0)).toHaveLength(1)
  })
})

describe('outbox — clearBackoff', () => {
  it('makes a backed-off key due immediately and resets its attempt count', () => {
    const box = outbox<string>(() => 30000)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)

    box.clearBackoff('A1')

    expect(box.take(0)).toHaveLength(1)
    expect(box.failures(0)).toEqual([])
  })

  it('clears every key when called without one', () => {
    const box = outbox<string>(() => 30000)
    box.set('A1', 'a')
    box.set('B2', 'b')
    for (const sent of box.take(0)) box.fail(sent.key, sent.sentVersion, new Error('boom'), 0)

    box.clearBackoff()

    expect(box.take(0)).toHaveLength(2)
  })

  it('leaves an in-flight key alone', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.take(0)

    box.clearBackoff('A1')

    expect(box.take(0)).toEqual([])
    expect(box.inFlightKeys()).toEqual(['A1'])
  })
})

describe('outbox — discard is the only way to lose a write', () => {
  it('drops the entry', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.discard('A1')

    expect(box.pendingKeys()).toEqual([])
    expect(box.take(0)).toEqual([])
  })

  it('drops an in-flight entry and ignores its late response', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.discard('A1')

    box.settle('A1', sent!.sentVersion)
    box.fail('A1', sent!.sentVersion, new Error('late'), 0)

    expect(box.pendingKeys()).toEqual([])
  })
})

describe('outbox — retryAt is a timestamp a consumer can render', () => {
  it('is undefined only while the key is blocked, never a bare 0', () => {
    const box = outbox<string>(() => undefined) // retry: false
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)

    expect(box.failures(5000)[0]?.retryAt).toBeUndefined()

    // Re-armed by an edit. The attempt count survives, so the key is still
    // listed as failed — and 0.1.0 published `retryAt: 0`, i.e. Jan 1 1970.
    box.set('A1', 'b')
    expect(box.failures(5000)[0]?.retryAt).toBe(5000)
  })

  it('is never in the past while a retry is on the wire', () => {
    const box = outbox<string>(() => 1000)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    expect(box.failures(0)[0]?.retryAt).toBe(1000)

    box.take(1000) // the retry goes out; the key is failed AND in flight
    expect(box.failures(1500)[0]?.retryAt).toBe(1500) // not 1000 — no negative countdown
  })

  it('reports the later of the two deadlines', () => {
    const box = outbox<string>(() => 1000)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0) // backoff to 1000
    box.set('A1', 'still-typing', 4000) // debounce to 4000

    expect(box.failures(0)[0]?.retryAt).toBe(4000)
    expect(box.take(1000)).toEqual([])
    expect(box.take(4000)).toHaveLength(1)
  })
})

describe('outbox — the debounce and the backoff are separate clocks', () => {
  it('a superseded success drops the backoff but not the quiet period', () => {
    const box = outbox<string>(() => 1000)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    const [retry] = box.take(1000)
    box.set('A1', 'typed-during-the-retry', 9000) // a keystroke asks for quiet until 9000

    box.settle('A1', retry!.sentVersion)

    expect(box.take(1500)).toEqual([]) // 0.1.0 zeroed the whole field here
    expect(box.take(9000)).toHaveLength(1)
  })

  it('an edit can push the quiet period out but never pull it in', () => {
    const box = outbox<string>()
    box.set('A1', 'a', 5000)
    box.set('A1', 'b', 100)

    expect(box.take(100)).toEqual([])
    expect(box.take(4999)).toEqual([])
    expect(box.take(5000)).toHaveLength(1)
  })

  it('a failure does not shorten a quiet period longer than the backoff', () => {
    const box = outbox<string>(() => 1000)
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.set('A1', 'typed-during-the-flight', 9000)

    box.fail('A1', sent!.sentVersion, new Error('boom'), 0)

    expect(box.take(1000)).toEqual([])
    expect(box.take(9000)).toHaveLength(1)
  })

  it('clearBackoff() answers for the backoff, not for a key being typed into', () => {
    const box = outbox<string>(() => 30000)
    box.set('A1', 'mid-typing', 5000)

    box.clearBackoff()

    expect(box.take(0)).toEqual([]) // the user's quiet period is theirs
    expect(box.take(5000)).toHaveLength(1)
  })
})

describe('outbox — a forced take', () => {
  it('ignores both clocks and the blocked flag', () => {
    const box = outbox<string>(() => undefined)
    box.set('A1', 'a', 90000)
    box.fail('A1', box.take(0, true)[0]!.sentVersion, new Error('boom'), 0)
    expect(box.take(90000)).toEqual([]) // blocked by retry: false

    expect(box.take(0, true)).toHaveLength(1) // flush() must still send it
  })
})

describe('outbox — the clock questions the scheduler asks', () => {
  it('hasWorkDueBy is false until the deadline and true after it', () => {
    const box = outbox<string>()
    box.set('A1', 'a', 500)

    expect(box.hasWorkDueBy(499)).toBe(false)
    expect(box.hasWorkDueBy(500)).toBe(true)
  })

  it('nextDeadline reports the earliest future deadline, and nothing once it is due', () => {
    const box = outbox<string>()
    box.set('A1', 'a', 900)
    box.set('B2', 'b', 400)

    expect(box.nextDeadline(0)).toBe(400)
    expect(box.nextDeadline(400)).toBe(900)
    expect(box.nextDeadline(900)).toBeUndefined()
  })

  it('ignores keys that are in flight or blocked', () => {
    const box = outbox<string>(() => undefined)
    box.set('A1', 'a')
    box.take(0)
    box.set('B2', 'b')
    box.fail('B2', box.take(0)[0]!.sentVersion, new Error('boom'), 0)

    expect(box.hasWorkDueBy(10000)).toBe(false)
    expect(box.nextDeadline(0)).toBeUndefined()
  })
})

describe('outbox — batch', () => {
  it('collapses a bulk edit into a single notification', () => {
    const onChange = vi.fn()
    const box = createOutbox<string>({ retryDelay: () => 1000, onChange })

    box.batch(() => {
      for (let i = 0; i < 100; i += 1) box.set(`cell-${i}`, 'pasted')
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(box.pendingKeys()).toHaveLength(100)
  })

  it('does not notify at all when nothing inside it changed', () => {
    const onChange = vi.fn()
    const box = createOutbox<string>({ retryDelay: () => 1000, onChange })

    box.batch(() => {
      box.take(0)
    })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('still notifies once when the body throws', () => {
    const onChange = vi.fn()
    const box = createOutbox<string>({ retryDelay: () => 1000, onChange })

    expect(() =>
      box.batch(() => {
        box.set('A1', 'a')
        throw new Error('consumer equals() blew up')
      }),
    ).toThrow('consumer equals() blew up')
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('outbox — change notification', () => {
  it('fires on every state transition so a UI layer can mirror it', () => {
    const onChange = vi.fn()
    const box = createOutbox<string>({ retryDelay: () => 1000, onChange })

    box.set('A1', 'a')
    expect(onChange).toHaveBeenCalledTimes(1)

    const [sent] = box.take(0)
    expect(onChange).toHaveBeenCalledTimes(2)

    box.settle('A1', sent!.sentVersion)
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('does not fire for a take that finds nothing', () => {
    const onChange = vi.fn()
    const box = createOutbox<string>({ retryDelay: () => 1000, onChange })

    box.take(0)

    expect(onChange).not.toHaveBeenCalled()
  })
})
