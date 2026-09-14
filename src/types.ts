/**
 * Public types.
 *
 * Leaf module: it imports nothing at all, at compile time or at runtime, so it
 * can be copied on its own.
 */

/** Outbox keys are plain strings — the keys of the record you pass in. */
export type WriteBehindKey = string

/**
 * The record whose keys are written back, or a getter for it.
 *
 * The getter form exists because this engine cannot observe an object: pass a
 * function when the record can be *replaced* (a framework adapter reading a
 * box, a module-level `let`), and call `sync()` when its contents change.
 *
 * **Precondition — keys are independent.** Everything in this library relies on
 * it: writes go out in parallel, in no particular order, last-write-wins per
 * key. If key `b` is only valid once key `a` has landed, this is the wrong tool
 * (that needs an ordered operation log — see the README's refuse list).
 */
export type WriteBehindSource<T> =
  | Record<WriteBehindKey, T>
  | (() => Record<WriteBehindKey, T>)

/**
 * What asked for a flush.
 *
 * `'unload'` is the only one a writer usually has to act on: the page is going
 * away, so the request has to outlive it. `'scheduled'` is the clock, and
 * `'manual'` is your own `flush()`.
 */
export type WriteBehindReason = 'scheduled' | 'manual' | 'unload'

/**
 * The third argument to a writer: *why* this send is happening.
 *
 * It exists for one reason — this library owns no transport, so it cannot set
 * `keepalive` for you. What it can do is tell you when it matters.
 *
 * ```ts
 * createWriteBehind(cells, (value, key, { final }) =>
 *   fetch(`/cell/${key}`, {
 *     method: 'PUT',
 *     body: JSON.stringify(value),
 *     keepalive: final,
 *   }),
 * )
 * ```
 */
export interface WriteBehindAttempt {
  /** What asked for this flush. */
  reason: WriteBehindReason
  /**
   * `true` when the page is going away: the request must outlive it, and
   * nothing will retry it.
   *
   * Equivalent to `reason === 'unload'`, and named separately because it is the
   * only question most writers ask. It is also `true` for a *backgrounded* tab,
   * which may well come back — no browser signal separates "hidden for a
   * second" from "gone" (iOS Safari fires `pagehide` for both), so this library
   * assumes the worse of the two.
   */
  final: boolean
  /**
   * Which try this is for this key: `1` on the first send, `2` after one
   * failure. Useful for an idempotency key, or for a writer that gives up on
   * its own terms.
   *
   * A batch writer gets the **highest** number in its batch — the batch is sent
   * and retried as a unit, so reporting anything lower would call it a first
   * try while part of the payload has already been out three times.
   */
  attempt: number
}

/**
 * Per-key writer — the common form.
 *
 * Called with the value read out of the outbox **at send time**, never a value
 * captured when the edit happened. Reject (or throw) to fail the key; the
 * return value is otherwise ignored on purpose — the server's reply never
 * touches local state.
 *
 * The third argument is additive: a `(value, key) => …` writer is still a valid
 * one, and reads exactly as it did before.
 */
export type WriteBehindWriter<T> = (
  value: T,
  key: WriteBehindKey,
  attempt: WriteBehindAttempt,
) => unknown

/** What a batch writer may resolve to in order to fail part of the batch. */
export interface WriteBehindBatchOutcome {
  /** Keys the server did not accept. Everything else in the batch is treated as written. */
  failed?: readonly WriteBehindKey[]
}

/**
 * Batch writer — one call for every due key.
 *
 * Throw/reject and the **whole batch** stays pending. Resolve with
 * `{ failed: [...] }` to fail part of it. Resolve with anything else (including
 * `undefined`) and the whole batch is treated as written.
 *
 * The second argument is additive, and this is the writer shape to reach for
 * when the page is going away: one request carrying every due key fits inside
 * the browser's 64 KiB `keepalive` budget where two hundred of them do not.
 */
export type WriteBehindBatchWriter<T> = (
  entries: [WriteBehindKey, T][],
  attempt: WriteBehindAttempt,
) => WriteBehindBatchOutcome | void | Promise<WriteBehindBatchOutcome | void>

/** Per-key exponential backoff. Defaults produce 1s → 2 → 4 → 8 → 16 → 30s, capped. */
export interface WriteBehindRetryOptions {
  /** Delay after the first failure, in ms. Default `1000`. */
  initialDelay?: number
  /** Ceiling for the delay, in ms. Default `30000`. */
  maxDelay?: number
  /** Multiplier applied per consecutive failure. Default `2`. */
  factor?: number
}

/** One key's latest failure. Only the newest error per key is kept. */
export interface WriteBehindFailure {
  key: WriteBehindKey
  /** Whatever the writer rejected with. */
  error: unknown
  /** Consecutive failures — resets on success, on `retry()`, and on `discard()`. */
  attempts: number
  /**
   * Epoch ms of the next automatic attempt. **Never in the past**: a key that
   * is due now (or whose retry is already on the wire) reports the current
   * time, so `retryAt - Date.now()` is a countdown you can render as-is.
   *
   * `undefined` means no automatic attempt is scheduled at all — the key failed
   * under `retry: false` and needs an edit, an explicit `retry(key)`, or a
   * `flush()`.
   */
  retryAt: number | undefined
}

/** Options shared by both writer shapes. Every one of them is an opt-*out*. */
export interface WriteBehindBaseOptions<T> {
  /** Flush cadence in ms. Default `1000`. The timer only runs while work is queued. */
  interval?: number
  /**
   * Per-key quiet period in ms before a key becomes eligible. Default `0`
   * (the `interval` already coalesces a burst of edits into one write).
   *
   * It is the consumer's clock and only `set`/an edit moves it: a response
   * landing mid-typing cannot cancel it, a failure cannot shorten it, and
   * `retry()` does not cut it short. It is tracked separately from the retry
   * backoff, so neither can shorten the other; a key waits for whichever is
   * later.
   */
  debounce?: number
  /**
   * Retry policy, or `false` to stop retrying a key after a failure. Retrying
   * is the default because dropping a user's edit is the one unacceptable
   * outcome. With `false` the key stays pending and listed in `failed` — it is
   * never discarded — until the next edit or an explicit `retry(key)`.
   */
  retry?: WriteBehindRetryOptions | false
  /**
   * Flush when the page goes away — `visibilitychange → hidden` *and*
   * `pagehide`, de-duplicated into one flush. Default `true`, and a no-op where
   * there is no `document`.
   *
   * That flush is the one that reports `reason: 'unload'`, so a writer can set
   * `keepalive` on it. Best-effort even then: the browser may freeze the page
   * before the request leaves, which is why `pending` is exposed.
   */
  flushOnHidden?: boolean
  /**
   * Run the flush clock. Default `true` — wherever `setInterval` exists, which
   * is the browser *and* Node.
   *
   * Pass `false` when timers are unwelcome or pointless: a server-side render
   * whose response is held open by a pending interval, or a script that decides
   * its own cadence. Nothing is lost — edits still queue, `pending` still
   * reports them, and `flush()` still sends them; only the automatic clock is
   * off. This is the one option a framework adapter is expected to set for you.
   */
  autoFlush?: boolean
  /**
   * Narrows what `sync()` picks up. An allow-list or a predicate.
   * Default: every key. `set()` is explicit and ignores this filter.
   */
  keys?: readonly WriteBehindKey[] | ((key: WriteBehindKey) => boolean)
  /**
   * Change detection for a key's value. Default `Object.is`.
   *
   * With the default, mutating an object value **in place** is not an edit —
   * replace the object, or call `set(key, value)`.
   */
  equals?: (a: T, b: T) => boolean
}

/**
 * Options for `createWriteBehind`. Exactly one writer: `write` (per key) or
 * `flush` (batched).
 */
export type WriteBehindOptions<T> = WriteBehindBaseOptions<T> &
  (
    | { write: WriteBehindWriter<T>; flush?: undefined }
    | { write?: undefined; flush: WriteBehindBatchWriter<T> }
  )

/**
 * What `createWriteBehind` returns.
 *
 * The four state members are **snapshot getters**, not live arrays: reading one
 * gives the value as of the last transition, and its identity does not change
 * while its contents do not. So `if (wb.pending !== last)` is a complete
 * change check — which is what makes `subscribe` cheap to sit behind.
 */
export interface WriteBehind<T> {
  /**
   * Every key with an unsaved change, **including** the ones currently on the
   * wire. This is the "you have unsaved work" number.
   */
  readonly pending: readonly WriteBehindKey[]
  /**
   * The subset of `pending` whose write is currently on the wire. A key held
   * back by a *discarded* write's request is not in it — see `discard`.
   */
  readonly inFlight: readonly WriteBehindKey[]
  /** Latest failure per failing key. */
  readonly failed: readonly WriteBehindFailure[]
  /** `true` while anything is in flight. */
  readonly isSyncing: boolean
  /**
   * Write a value into the source **and** queue it. Always queues, even when
   * the value is unchanged — the escape hatch for values `equals` cannot see
   * (an object mutated in place) and for keys excluded by `keys`.
   */
  set: (key: WriteBehindKey, value: T) => void
  /**
   * "I changed the record." Diff the source against what this engine last saw
   * and queue whatever moved.
   *
   * Idempotent and cheap when nothing has: it is a walk of the record, not a
   * request. Nothing else can notice an edit made directly on the object —
   * there is no observer here — so this is the call that makes `cells.A1 =
   * 'bar'` mean something. A framework adapter wires it to its own reactivity.
   */
  sync: () => void
  /**
   * `sync()`, then send every pending key that is not already in flight,
   * ignoring the `debounce` clock, the retry backoff **and** `retry: false`'s
   * parked state. A key already on the wire is the one thing it cannot send: a
   * request cannot be recalled, and a second one could land out of order.
   *
   * Resolves when the requests it started have settled — it never rejects, and
   * resolving is not proof of success. Read `pending` / `failed` afterwards to
   * see what landed; keys edited *during* the flight are still pending.
   *
   * Pass `'unload'` to tell the writer the page is going away, exactly as the
   * automatic flush does. That is the escape hatch for a signal this library
   * refuses to listen to itself — a `beforeunload` handler you insist on, a
   * router leave guard, an Electron close hook.
   */
  flush: (reason?: Exclude<WriteBehindReason, 'scheduled'>) => Promise<void>
  /**
   * Clear the retry backoff (and the recorded failure) for one key, or all of
   * them, so they go out on the next tick. Revives a key parked by
   * `retry: false`. It does not touch a `debounce` quiet period — that belongs
   * to the user's typing, not to the failure.
   */
  retry: (key?: WriteBehindKey) => void
  /**
   * Drop a key's pending write. **The only operation in this library that
   * loses a write** — nothing else ever discards one.
   *
   * A request already on the wire for that key cannot be recalled: its result
   * is ignored, but the key stays reserved until it answers, so a write queued
   * in the meantime can never race it and land out of order. While that lasts
   * the key is in `pending` and not in `inFlight`.
   */
  discard: (key: WriteBehindKey) => void
  /**
   * Call `listener` after every outbox transition, once the snapshots above
   * have been refreshed. Returns the unsubscribe.
   *
   * It is handed nothing: read the getters, and compare identities to find what
   * actually moved.
   */
  subscribe: (listener: () => void) => () => void
  /**
   * Stop the clock and drop the page-hidden listeners. Idempotent, and it loses
   * nothing — queued writes stay queued, they just stop going out by
   * themselves.
   */
  dispose: () => void
}
