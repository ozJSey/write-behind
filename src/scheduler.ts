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
  } = retry ?? {}
  return (attempts) => Math.min(initialDelay * factor ** (attempts - 1), maxDelay)
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
