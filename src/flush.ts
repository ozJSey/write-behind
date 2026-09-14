/**
 * The writer adapters — the only place a request is made.
 *
 * Two shapes, one rule: whatever the network does, the outcome is reported back
 * to the outbox and nothing else. This module never clears a key itself, never
 * looks at what a writer resolved with, and never touches local state. The
 * server's reply is discarded on purpose.
 *
 * Per-key writes are independent, so they run in parallel and each key settles
 * the moment its own request returns: every request is wrapped in its own
 * `try`/`catch`, so one rejection can neither block nor fail a sibling, and
 * `flush()` waits with `Promise.allSettled`. That is safe only because key
 * independence is a stated precondition of the library.
 */
import type { Outbox, OutboxEntry } from './outbox'
import type {
  WriteBehindAttempt,
  WriteBehindBatchOutcome,
  WriteBehindBatchWriter,
  WriteBehindKey,
  WriteBehindReason,
  WriteBehindWriter,
} from './types'

/** Exactly one writer, already narrowed from the options. */
export type ResolvedWriter<T> =
  | { write: WriteBehindWriter<T>; flush?: undefined }
  | { write?: undefined; flush: WriteBehindBatchWriter<T> }

export interface FlusherConfig<T> {
  outbox: Outbox<T>
  writer: ResolvedWriter<T>
  /** Injected so the flusher owns no clock of its own. */
  now: () => number
}

export interface Flusher {
  /**
   * Send everything due, and tell each writer why.
   *
   * Everything but `'scheduled'` is **forced**: it ignores the debounce clock,
   * the retry backoff and `retry: false`'s blocked flag, because a `flush()` a
   * user pressed and the last flush before the page dies both mean "now, not
   * when the clock says so". Never a request already on the wire, though —
   * that one cannot be recalled.
   */
  dispatch: (reason?: WriteBehindReason) => void
  /** Force a dispatch and wait for every request currently in the air. */
  flush: (reason?: WriteBehindReason) => Promise<void>
}

const failedKeysOf = (outcome: WriteBehindBatchOutcome | void): readonly WriteBehindKey[] => {
  if (!outcome) return []
  return outcome.failed ?? []
}

/**
 * One batch, one attempt number: the highest in it. The batch goes out and
 * comes back as a unit, so the most-retried key in it is the honest answer —
 * reporting `1` would tell a writer this is a first try while part of the
 * payload has already been out three times.
 */
const highestAttempt = <T>(batch: OutboxEntry<T>[]): number => {
  let highest = 1
  for (const entry of batch) if (entry.attempt > highest) highest = entry.attempt
  return highest
}

export function createFlusher<T>({ outbox, writer, now }: FlusherConfig<T>): Flusher {
  const inAir = new Set<Promise<void>>()

  const track = (flight: Promise<void>): void => {
    inAir.add(flight)
    void flight.then(() => inAir.delete(flight))
  }

  const runPerKey = async (
    write: WriteBehindWriter<T>,
    entry: OutboxEntry<T>,
    attempt: WriteBehindAttempt,
  ): Promise<void> => {
    try {
      await write(entry.value, entry.key, attempt)
      outbox.settle(entry.key, entry.sentVersion)
    } catch (error) {
      outbox.fail(entry.key, entry.sentVersion, error, now())
    }
  }

  const runBatch = async (
    flushAll: WriteBehindBatchWriter<T>,
    batch: OutboxEntry<T>[],
    attempt: WriteBehindAttempt,
  ): Promise<void> => {
    const entries = batch.map((entry): [WriteBehindKey, T] => [entry.key, entry.value])
    try {
      const failed = new Set(failedKeysOf(await flushAll(entries, attempt)))
      for (const entry of batch) {
        if (failed.has(entry.key)) {
          outbox.fail(
            entry.key,
            entry.sentVersion,
            new Error(`write-behind: batch flush reported "${entry.key}" as failed`),
            now(),
          )
        } else {
          outbox.settle(entry.key, entry.sentVersion)
        }
      }
    } catch (error) {
      // One rejection means the transport failed, so nothing in the batch is
      // known to have landed — every key stays pending.
      for (const entry of batch) outbox.fail(entry.key, entry.sentVersion, error, now())
    }
  }

  const dispatch = (reason: WriteBehindReason = 'scheduled'): void => {
    const batch = outbox.take(now(), reason !== 'scheduled')
    if (batch.length === 0) return
    // `final` is redundant with `reason`, deliberately: "is the page going
    // away" is the only question most writers ask, and `{ final }` in the
    // parameter list reads better than a string comparison in every writer.
    const final = reason === 'unload'
    // The union guarantees exactly one of the two is present.
    if (writer.flush) {
      track(runBatch(writer.flush, batch, { reason, final, attempt: highestAttempt(batch) }))
    } else {
      for (const entry of batch) {
        track(runPerKey(writer.write, entry, { reason, final, attempt: entry.attempt }))
      }
    }
  }

  return {
    dispatch,
    flush: async (reason = 'manual') => {
      dispatch(reason)
      // allSettled, not all: `runPerKey`/`runBatch` already absorb every
      // rejection, and a caller awaiting flush() must not inherit one.
      await Promise.allSettled([...inAir])
    },
  }
}
