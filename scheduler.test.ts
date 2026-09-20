/**
 * The clock: the flush interval and the per-key backoff curve. Fake timers
 * only — nothing here knows what a write is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackoff, createScheduler } from './src/scheduler'

describe('createBackoff', () => {
  it('runs 1 → 2 → 4 → 8 → 16s across the five retries it allows', () => {
    const backoff = createBackoff(undefined)

    expect([1, 2, 3, 4, 5].map(backoff)).toEqual([1000, 2000, 4000, 8000, 16000])
  })

  /**
   * The default used to be unbounded: `min(1000 * 2 ** (n - 1), 30000)` for
   * every n, so a write that could never succeed — a 400, a malformed payload,
   * a worker module that throws at load — retried every 30 seconds for the
   * life of the page. Nothing capped it and there was no option that could.
   */
  it('gives up after five retries instead of retrying for the life of the page', () => {
    const backoff = createBackoff(undefined)

    expect(backoff(5)).toBe(16000)
    expect(backoff(6)).toBeUndefined()
    expect([7, 20, 1000].map(backoff)).toEqual([undefined, undefined, undefined])
  })

  it('honours a custom ceiling on the number of retries', () => {
    const backoff = createBackoff({ maxRetries: 2 })

    expect([1, 2].map(backoff)).toEqual([1000, 2000])
    expect(backoff(3)).toBeUndefined()
  })

  /**
   * The old behaviour is still reachable, by name. Someone writing to a queue
   * that is expected to be down for hours wants it, and it should be a choice
   * rather than the thing you get by not knowing about it.
   */
  it('maxRetries: Infinity restores the unbounded curve, capped at maxDelay', () => {
    const backoff = createBackoff({ maxRetries: Infinity })

    expect([5, 6, 7, 20, 1000].map(backoff)).toEqual([16000, 30000, 30000, 30000, 30000])
  })

  it('honours a custom curve', () => {
    const backoff = createBackoff({ initialDelay: 100, factor: 3, maxDelay: 1000 })

    expect([1, 2, 3, 4].map(backoff)).toEqual([100, 300, 900, 1000])
  })

  it('returns undefined for every attempt when retry is off', () => {
    const backoff = createBackoff(false)

    expect([1, 2, 99].map(backoff)).toEqual([undefined, undefined, undefined])
  })

  it('never returns a delay above the cap, whatever the attempt count', () => {
    // `maxRetries: Infinity` because this is testing the CAP, not the ceiling
    // on attempts: with the default five the curve would be blocked long
    // before attempt 50 and the overflow it guards against — `1000 * 10 ** 49`
    // — would never be computed at all.
    const backoff = createBackoff({ initialDelay: 1000, factor: 10, maxRetries: Infinity })

    expect(backoff(50)).toBe(30000)
    expect(Number.isFinite(backoff(1000) ?? Number.POSITIVE_INFINITY)).toBe(true)
  })
})

describe('createScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not tick until it is started', () => {
    const onTick = vi.fn()
    createScheduler({ interval: 1000, onTick })

    vi.advanceTimersByTime(5000)

    expect(onTick).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ticks on the interval once started', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.start()
    vi.advanceTimersByTime(999)
    expect(onTick).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onTick).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2000)
    expect(onTick).toHaveBeenCalledTimes(3)
  })

  it('start() is idempotent — it never resets the phase or doubles the rate', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.start()
    vi.advanceTimersByTime(900)
    scheduler.start()
    scheduler.start()
    vi.advanceTimersByTime(100)

    expect(onTick).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('stop() clears the timer so nothing is left running', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.start()
    scheduler.stop()

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10000)
    expect(onTick).not.toHaveBeenCalled()
  })

  it('stop() is safe when it was never started', () => {
    const scheduler = createScheduler({ interval: 1000, onTick: vi.fn() })

    expect(() => scheduler.stop()).not.toThrow()
  })

  it('wakeAt() ticks once at a deadline the interval grid would have missed', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.wakeAt(250, 0)
    vi.advanceTimersByTime(249)
    expect(onTick).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onTick).toHaveBeenCalledTimes(1)

    // One shot, not a second cadence.
    vi.advanceTimersByTime(5000)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wakeAt() replaces a pending wake-up rather than stacking them', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.wakeAt(500, 0)
    scheduler.wakeAt(300, 0)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(300)
    expect(onTick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('wakeAt() re-arming the same deadline does not restart it', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.wakeAt(400, 0)
    vi.advanceTimersByTime(399)
    scheduler.wakeAt(400, 399)
    vi.advanceTimersByTime(1)

    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('wakeAt(undefined) cancels a pending wake-up', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.wakeAt(500, 0)
    scheduler.wakeAt(undefined, 0)

    vi.advanceTimersByTime(5000)
    expect(onTick).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a deadline already in the past fires on the next turn, not never', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.wakeAt(100, 5000)
    vi.advanceTimersByTime(0)

    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('dispose() clears the interval and the pending wake-up together', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.start()
    scheduler.wakeAt(500, 0)
    scheduler.dispose()

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10000)
    expect(onTick).not.toHaveBeenCalled()
  })
})
