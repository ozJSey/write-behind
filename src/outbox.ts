/**
 * The outbox: the pure key/version/dirty state machine.
 *
 * No timers and no I/O — every clock reading arrives as an argument. This
 * is where the whole library's correctness lives, which is why it is testable
 * without mounting anything.
 *
 * **Invariant: this module is the only place a dirty key is ever cleared.**
 * Everything else (scheduler, flush, the engine) can only ask.
 *
 * The rule that makes it correct: a key carries a **monotonic version**, and a
 * write records the version it was sent at. A success clears the key only when
 * the version has not moved since. A boolean dirty flag cannot express that —
 * the response would clear a flag a newer edit had set, and that edit would be
 * gone with nothing on screen to say so.
 *
 * Three facts about a key are kept in three separate places on purpose, because
 * folding them into one mutable record is what shipped the 0.1.0 data-loss bug:
 *
 *   - **what is queued** — the `Entry` in `entries`. `discard()` deletes this.
 *   - **what is on the wire** — the `Flight` in `flights`. Nothing but a
 *     response removes this, so discarding a key cannot forget that its request
 *     is still out and let a second one race it.
 *   - **when the key may go** — two independent deadlines on the entry:
 *     `readyAt` (the consumer's debounce) and `backoffUntil` (our retry curve).
 *     One field could not hold both, so a response handler used to cancel the
 *     user's quiet period.
 */
import type { WriteBehindFailure, WriteBehindKey } from './types'

/** One entry handed to a writer. `value` is read out of the map at take time. */
export interface OutboxEntry<T> {
  key: WriteBehindKey
  value: T
  /**
   * The version this send is for — the flight's identity. Hand it back to
   * `settle`/`fail`: a response from a flight that is no longer the one on the
   * wire (the key was discarded and re-queued, or `retry()` re-armed it) is
   * ignored instead of clearing the wrong write.
   */
  sentVersion: number
  /**
   * Which try this send is for this key: `1` the first time, `2` after one
   * failure. Read off `attempts`, which counts failures, so it is always one
   * ahead of it — a writer building an idempotency key wants the try number,
   * not the failure count.
   */
  attempt: number
}

interface Entry<T> {
  value: T
  /** Bumped on every edit. Unique across the whole outbox, never reused. */
  version: number
  /** Consecutive failures. */
  attempts: number
  error: unknown
  /**
   * Epoch ms before which the consumer's `debounce` holds the key. Written by
   * `set` and by nothing else — a network outcome may never cancel the user's
   * quiet period. `0` = no quiet period.
   */
  readyAt: number
  /**
   * Epoch ms before which our own retry backoff holds the key. Written by
   * `fail`, cleared by a success and by `clearBackoff`. `0` = no backoff.
   */
  backoffUntil: number
  /** Failed with retries disabled: needs a fresh edit, an explicit retry, or a forced take. */
  blocked: boolean
}

/** A request on the wire. Outlives the entry it was taken from. */
interface Flight {
  /** The version the request carries — its identity. */
  version: number
  /**
   * `false` once the entry it was taken from has been discarded. The request
   * cannot be recalled, so it still reserves the key; but its outcome belongs
   * to a write nobody wants any more, and must not be recorded against
   * whatever has been queued for the key since.
   */
  owned: boolean
}

export interface OutboxConfig {
  /**
   * Backoff for the n-th consecutive failure, in ms. Returning `undefined`
   * blocks the key instead of scheduling an attempt (`retry: false`).
   */
  retryDelay: (attempts: number) => number | undefined
  /** Called after every state transition. */
  onChange?: () => void
}

export interface Outbox<T> {
  /**
   * Queue a value. `readyAt` (epoch ms) is the consumer's debounce deadline; it
   * can only ever push the key further out. It is a separate deadline from the
   * retry backoff, so an edit can neither shorten nor extend one.
   */
  set: (key: WriteBehindKey, value: T, readyAt?: number) => void
  /**
   * Claim every key that is due at `now` and not already on the wire, marking
   * each in flight. `force` ignores both deadlines and the blocked flag — it
   * never ignores a flight, because a request cannot be recalled.
   */
  take: (now: number, force?: boolean) => OutboxEntry<T>[]
  /** The write landed. Clears the key **only if** its version has not moved. */
  settle: (key: WriteBehindKey, sentVersion: number) => void
  /** The write failed. Never clears the key. */
  fail: (key: WriteBehindKey, sentVersion: number, error: unknown, now: number) => void
  /**
   * Forget a key's pending write entirely — the one operation that loses one.
   * A request already on the wire for that key stays on the wire and stays
   * recorded: it cannot be recalled, so the key is held back until it answers.
   */
  discard: (key: WriteBehindKey) => void
  /** Make a key (or all of them) eligible again and forget its failure. */
  clearBackoff: (key?: WriteBehindKey) => void
  /** Every unconfirmed key, in-flight ones included. */
  pendingKeys: () => WriteBehindKey[]
  /**
   * The subset of `pendingKeys()` whose own write is on the wire. A key held
   * back by a *discarded* write's request is not in it: that request belongs to
   * nobody, and reporting the key as syncing would claim the queued value is
   * being saved when it is not.
   */
  inFlightKeys: () => WriteBehindKey[]
  /** Latest failure per failing key. `now` clamps `retryAt` out of the past. */
  failures: (now: number) => WriteBehindFailure[]
  /** True when some key is eligible to be taken at `now` — i.e. run the interval. */
  hasWorkDueBy: (now: number) => boolean
  /**
   * The earliest deadline after `now` at which some key becomes eligible, or
   * `undefined` when nothing is waiting on the clock. The scheduler wakes for
   * it, so a backoff is honoured to the millisecond instead of being rounded up
   * to the next interval tick.
   */
  nextDeadline: (now: number) => number | undefined
  /** Run `mutate`, collapsing every transition inside it into one notification. */
  batch: (mutate: () => void) => void
}

export function createOutbox<T>({ retryDelay, onChange }: OutboxConfig): Outbox<T> {
  const entries = new Map<WriteBehindKey, Entry<T>>()
  /**
   * Key → the version currently on the wire for it. Separate from `entries` so
   * that deleting an entry cannot delete the library's memory of a request in
   * flight; that is exactly the bug that let two requests race in 0.1.0.
   */
  const flights = new Map<WriteBehindKey, Flight>()
  // One counter for the whole outbox rather than one per key: versions are then
  // never reused, so a response from a discarded flight can never be mistaken
  // for the current one on a key that was queued again in the meantime.
  let version = 0

  let batchDepth = 0
  let batchedChange = false
  const notify = (): void => {
    if (batchDepth > 0) {
      batchedChange = true
      return
    }
    onChange?.()
  }

  const batch = (mutate: () => void): void => {
    batchDepth += 1
    try {
      mutate()
    } finally {
      batchDepth -= 1
      if (batchDepth === 0 && batchedChange) {
        batchedChange = false
        onChange?.()
      }
    }
  }

  /** Epoch ms from which this key is eligible: the later of its two deadlines. */
  const eligibleAt = (entry: Entry<T>): number => Math.max(entry.readyAt, entry.backoffUntil)

  const set = (key: WriteBehindKey, value: T, readyAt = 0): void => {
    version += 1
    const entry = entries.get(key)
    if (entry) {
      entry.value = value
      entry.version = version
      // A new value is a new write, not a retry — it re-arms a blocked key…
      entry.blocked = false
      // …but it must not shorten the quiet period the previous keystroke asked
      // for, and it cannot touch the backoff at all: that lives in its own
      // field, so a user typing into a failing endpoint still fires one request
      // per backoff window rather than one per keystroke.
      entry.readyAt = Math.max(entry.readyAt, readyAt)
    } else {
      entries.set(key, {
        value,
        version,
        attempts: 0,
        error: undefined,
        readyAt,
        backoffUntil: 0,
        blocked: false,
      })
    }
    notify()
  }

  const take = (now: number, force = false): OutboxEntry<T>[] => {
    const claimed: OutboxEntry<T>[] = []
    for (const [key, entry] of entries) {
      // H5, and the one rule `force` may not override: a request already on the
      // wire cannot be recalled, so a second one for the same key could land
      // out of order and leave the server holding the older value.
      if (flights.has(key)) continue
      if (!force) {
        if (entry.blocked) continue
        if (eligibleAt(entry) > now) continue
      }
      flights.set(key, { version: entry.version, owned: true })
      claimed.push({
        key,
        value: entry.value,
        sentVersion: entry.version,
        attempt: entry.attempts + 1,
      })
    }
    if (claimed.length > 0) notify()
    return claimed
  }

  /**
   * The response's own flight, if it is still the one on the wire for `key`;
   * `undefined` for a response that has been superseded and must be ignored.
   */
  const currentFlight = (key: WriteBehindKey, sentVersion: number): Flight | undefined => {
    const flight = flights.get(key)
    return flight?.version === sentVersion ? flight : undefined
  }

  const settle = (key: WriteBehindKey, sentVersion: number): void => {
    const flight = currentFlight(key, sentVersion)
    if (!flight) return
    flights.delete(key)
    // A response speaks only for the entry its own flight was taken from. For a
    // disowned flight that entry is gone, and whatever is queued for the key
    // now is a different write this response says nothing about — so the key is
    // freed and nothing else happens.
    const entry = flight.owned ? entries.get(key) : undefined
    if (entry) {
      if (entry.version === sentVersion) {
        // Nothing was typed while this was in flight: the key is saved.
        entries.delete(key)
      } else {
        // It was. Keep it dirty and send the newer value; the server is
        // evidently healthy, so drop the backoff — but not `readyAt`, which is
        // the user's own quiet period and none of the network's business.
        entry.attempts = 0
        entry.error = undefined
        entry.backoffUntil = 0
        entry.blocked = false
      }
    }
    notify()
  }

  const fail = (key: WriteBehindKey, sentVersion: number, error: unknown, now: number): void => {
    const flight = currentFlight(key, sentVersion)
    if (!flight) return
    flights.delete(key)
    const entry = entries.get(key)
    // A discarded write has nothing left to retry and nobody to report to —
    // recording its failure against the key's next write would invent an
    // attempt that never happened.
    if (flight.owned && entry) {
      entry.attempts += 1
      entry.error = error
      const delay = retryDelay(entry.attempts)
      if (delay === undefined) entry.blocked = true
      else entry.backoffUntil = now + delay
    }
    notify()
  }

  const discard = (key: WriteBehindKey): void => {
    const flight = flights.get(key)
    const disowned = flight?.owned === true
    // The request cannot be recalled: it keeps reserving the key so the next
    // edit cannot race it, but nobody owns its outcome any more.
    if (flight) flight.owned = false
    const dropped = entries.delete(key)
    if (!dropped && !disowned) return
    notify()
  }

  const clearBackoff = (key?: WriteBehindKey): void => {
    const targets = key === undefined ? entries.values() : [entries.get(key)]
    for (const entry of targets) {
      if (!entry) continue
      entry.attempts = 0
      entry.error = undefined
      entry.backoffUntil = 0
      entry.blocked = false
      // `readyAt` survives: retry() answers for our backoff, not for a key the
      // user is still typing into.
    }
    notify()
  }

  const failures = (now: number): WriteBehindFailure[] => {
    const list: WriteBehindFailure[] = []
    for (const [key, entry] of entries) {
      if (entry.attempts === 0) continue
      list.push({
        key,
        error: entry.error,
        attempts: entry.attempts,
        // Never the raw internal deadline: `0` would publish 1970, and a
        // deadline already reached would publish a negative countdown.
        retryAt: entry.blocked ? undefined : Math.max(eligibleAt(entry), now),
      })
    }
    return list
  }

  /**
   * Could this key go out on its own once its clock allows? The single
   * definition both scheduler questions below are asked against.
   */
  const isSchedulable = (key: WriteBehindKey, entry: Entry<T>): boolean =>
    !flights.has(key) && !entry.blocked

  const hasWorkDueBy = (now: number): boolean => {
    for (const [key, entry] of entries) {
      if (!isSchedulable(key, entry)) continue
      if (eligibleAt(entry) <= now) return true
    }
    return false
  }

  const nextDeadline = (now: number): number | undefined => {
    let earliest: number | undefined
    for (const [key, entry] of entries) {
      if (!isSchedulable(key, entry)) continue
      const at = eligibleAt(entry)
      if (at <= now) continue
      if (earliest === undefined || at < earliest) earliest = at
    }
    return earliest
  }

  return {
    set,
    take,
    settle,
    fail,
    discard,
    clearBackoff,
    pendingKeys: () => [...entries.keys()],
    inFlightKeys: () =>
      [...entries.keys()].filter((key) => flights.get(key)?.owned === true),
    failures,
    hasWorkDueBy,
    nextDeadline,
    batch,
  }
}
