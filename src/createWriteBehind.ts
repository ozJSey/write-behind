/**
 * The engine — the one place the six modules below are wired together.
 *
 * It reads local state and never writes it back: nothing here applies a server
 * response to the record, because the whole point is that the value the user is
 * typing cannot be overwritten from the network.
 *
 * This module owns the library's single `Date.now()` call site (`now` below).
 * Everything under it — the outbox, the flusher, the scheduler, the snapshots —
 * is handed the reading rather than taking one.
 *
 * The seam worth understanding is `sync()`. A plain object cannot announce that
 * it changed, so *something* has to say "look again" — a framework's reactivity,
 * an event handler, or a call at the end of whatever mutated the record. That is
 * the only thing an adapter such as `@ozjsey/vue-write-behind` adds on top.
 */
import { createFlusher, type ResolvedWriter } from './flush'
import { createOutbox } from './outbox'
import { createBackoff, createScheduler } from './scheduler'
import { createShadow } from './shadow'
import { createSnapshot } from './snapshot'
import type {
  WriteBehind,
  WriteBehindKey,
  WriteBehindOptions,
  WriteBehindReason,
  WriteBehindSource,
  WriteBehindWriter,
} from './types'
import { onPageHidden } from './visibility'

const DEFAULT_INTERVAL = 1000

/**
 * Write-behind cache for a record of independent keys. Local state stays
 * authoritative; the writer's result is discarded on purpose.
 *
 * @example
 * ```ts
 * const cells: Record<string, string> = { A1: 'foo' }
 * const wb = createWriteBehind(cells, (value, key) => api.put(`/cell/${key}`, value))
 *
 * cells.A1 = 'bar'
 * wb.sync()             // "I changed the record" — diff it and queue what moved
 * wb.set('A1', 'bar')   // or do both in one call, skipping the diff
 * ```
 *
 * @param source The record, or a getter for it when the object itself can be
 *   replaced. Its keys must be independent of each other — writes go out in
 *   parallel, last-write-wins.
 * @param writerOrOptions The per-key writer, or an options object carrying
 *   either `write` (per key) or `flush` (batched).
 */
export function createWriteBehind<T>(
  source: WriteBehindSource<T>,
  writerOrOptions: WriteBehindWriter<T> | WriteBehindOptions<T>,
): WriteBehind<T> {
  const options: WriteBehindOptions<T> =
    typeof writerOrOptions === 'function' ? { write: writerOrOptions } : writerOrOptions

  const writer: ResolvedWriter<T> = options.flush
    ? { flush: options.flush }
    : { write: options.write }

  const interval = options.interval ?? DEFAULT_INTERVAL
  const debounce = options.debounce ?? 0
  const equals = options.equals ?? Object.is
  const autoFlush = options.autoFlush ?? true
  const keys = options.keys
  const tracked: (key: WriteBehindKey) => boolean =
    keys === undefined
      ? () => true
      : typeof keys === 'function'
        ? keys
        : (key) => keys.includes(key)

  /** The one clock in the library. Every module below is handed its reading. */
  const now = (): number => Date.now()
  /** The debounce deadline for an edit happening right now. */
  const readyAt = (): number => (debounce > 0 ? now() + debounce : 0)

  const read: () => Record<WriteBehindKey, T> =
    typeof source === 'function' ? source : () => source

  const outbox = createOutbox<T>({
    retryDelay: createBackoff(options.retry),
    onChange: () => onOutboxChange(),
  })
  const snapshot = createSnapshot(outbox)
  const flusher = createFlusher<T>({ outbox, writer, now })
  const scheduler = createScheduler({
    interval,
    onTick: () => {
      flusher.dispatch()
      // A tick that sent nothing produces no outbox transition, so the next
      // wake-up has to be re-armed here rather than from onChange alone.
      reschedule()
    },
  })
  const shadow = createShadow<T>({ read, tracked, equals })

  const listeners = new Set<() => void>()
  let disposed = false

  /**
   * Run the interval only while something is actually eligible, and arm a
   * one-shot for the next deadline that is not. Never after `dispose()`, and
   * never left running with nothing to send — an idle app must not hold the
   * event loop open.
   */
  function reschedule(): void {
    // Without this, a response landing after `dispose()` would notify, find the
    // key still dirty, and start a brand new interval on a disposed engine.
    if (!autoFlush || disposed) return
    const at = now()
    if (outbox.hasWorkDueBy(at)) scheduler.start()
    else scheduler.stop()
    scheduler.wakeAt(outbox.nextDeadline(at), at)
  }

  function onOutboxChange(): void {
    // Snapshots first, then the clock, then the world: a listener must never
    // observe a state the engine has not finished reacting to itself.
    snapshot.refresh(now())
    reschedule()
    for (const listener of listeners) listener()
  }

  const sync = (): void => {
    const deadline = readyAt()
    // One notification for the whole sweep: a 2000-key paste used to rebuild
    // every snapshot 2000 times.
    outbox.batch(() => {
      for (const [key, value] of shadow.changes()) outbox.set(key, value, deadline)
    })
  }

  const flush = (reason: Exclude<WriteBehindReason, 'scheduled'> = 'manual'): Promise<void> => {
    // Diff first: an edit the adapter has not reported yet would otherwise be
    // missed, and a save button next to an input must not lose the last
    // keystroke. It is what makes the unload flush carry the character typed
    // 200 ms before the tab closed.
    sync()
    return flusher.flush(reason)
  }

  const stopHiddenListener =
    options.flushOnHidden === false ? () => {} : onPageHidden(() => void flush('unload'))

  return {
    get pending() {
      return snapshot.pending
    },
    get inFlight() {
      return snapshot.inFlight
    },
    get failed() {
      return snapshot.failed
    },
    get isSyncing() {
      return snapshot.isSyncing
    },
    set: (key, value) => {
      read()[key] = value
      shadow.record(key, value)
      // Unconditional: `set` is the escape hatch for a change `equals` cannot
      // see (an object mutated in place) and for keys `keys` filters out.
      outbox.set(key, value, readyAt())
    },
    sync,
    flush,
    retry: (key) => outbox.clearBackoff(key),
    discard: (key) => outbox.discard(key),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => {
      disposed = true
      scheduler.dispose()
      stopHiddenListener()
    },
  }
}
