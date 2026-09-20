/**
 * The clock — the flush interval, the wake-up for a deadline that falls between
 * two ticks, and the per-key backoff curve.
 *
 * Deliberately ignorant of writes and keys: it only knows "call this every N
 * ms", "call this once at time T" and "how long after the n-th failure". The
 * decision to run at all belongs to `createWriteBehind`, which starts it when work
 * is queued and stops it when there is none — an idle app must not hold a timer
 * open.
 */
import type { WriteBehindRetryOptions } from './types'

const DEFAULT_INITIAL_DELAY = 1000
const DEFAULT_MAX_DELAY = 30000
const DEFAULT_FACTOR = 2
/**
 * Five retries — 1s, 2, 4, 8, 16 — so a key that cannot land stops trying
 * about half a minute after it started, and says so.
 *
 * There was no ceiling at all before. A write that could never succeed — a
 * 400, a malformed payload, a worker module that throws at load because its
 * context is incomplete — retried every `maxDelay` for the life of the page,
 * because the curve treated a permanent failure exactly like a flaky network.
 * `Infinity` restores that, by name, for the caller who genuinely wants it.
 */
const DEFAULT_MAX_RETRIES = 5

/**
 * Backoff for the n-th consecutive failure (1-based), in ms — or `undefined`
 * when retries are off, which parks the key until it is edited or retried.
 *
 * The cap matters: `factor ** attempts` reaches Infinity within a couple of
 * dozen failures, and a key parked at `Infinity` would never be retried, which
 * is exactly the silent write loss this library exists to prevent.
 */
export function createBackoff(
  retry: WriteBehindRetryOptions | false | undefined,
): (attempts: number) => number | undefined {
  if (retry === false) return () => undefined
  const {
    initialDelay = DEFAULT_INITIAL_DELAY,
    maxDelay = DEFAULT_MAX_DELAY,
    factor = DEFAULT_FACTOR,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = retry ?? {}
  return (attempts) => {
    // `attempts` is the consecutive-failure count, so `attempts > maxRetries`
    // is the failure AFTER the last retry we agreed to schedule. Returning
    // undefined here is the outbox's existing "blocked" signal: the key keeps
    // its value and its place, and waits for a fresh edit, an explicit
    // `retry()`, or a forced take. Nothing is dropped — giving up on the
    // schedule is not giving up on the write.
    if (attempts > maxRetries) return undefined
    return Math.min(initialDelay * factor ** (attempts - 1), maxDelay)
  }
}

export interface SchedulerConfig {
  interval: number
  onTick: () => void
}

export interface Scheduler {
  /** Idempotent: calling it while running keeps the current phase. */
  start: () => void
  /** Stops the interval. A pending wake-up is left armed — it is a deadline, not a cadence. */
  stop: () => void
  /**
   * Tick once at `deadline` (epoch ms), on top of the interval — that is what
   * makes a `retry.initialDelay` shorter than `interval` mean anything, instead
   * of being rounded up to the next tick of the grid. Replaces any pending
   * wake-up; `undefined` cancels it.
   */
  wakeAt: (deadline: number | undefined, now: number) => void
  /** Clear everything — the interval and any pending wake-up. */
  dispose: () => void
}

export function createScheduler({ interval, onTick }: SchedulerConfig): Scheduler {
  let timer: ReturnType<typeof setInterval> | undefined
  let wake: ReturnType<typeof setTimeout> | undefined
  let wakeDeadline: number | undefined

  const clearWake = (): void => {
    if (wake === undefined) return
    clearTimeout(wake)
    wake = undefined
    wakeDeadline = undefined
  }

  const stop = (): void => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  return {
    start: () => {
      // Restarting would reset the phase, so a fast typist could push the flush
      // out indefinitely — the interval has to be a fixed window, not a debounce.
      if (timer !== undefined) return
      timer = setInterval(onTick, interval)
    },
    stop,
    wakeAt: (deadline, now) => {
      if (deadline === undefined) {
        clearWake()
        return
      }
      if (wake !== undefined && wakeDeadline === deadline) return
      clearWake()
      wakeDeadline = deadline
      wake = setTimeout(() => {
        wake = undefined
        wakeDeadline = undefined
        onTick()
      }, Math.max(deadline - now, 0))
    },
    dispose: () => {
      stop()
      clearWake()
    },
  }
}
