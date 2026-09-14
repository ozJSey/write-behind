/**
 * No-DOM safety suite.
 *
 * Runs in vitest's `environment: 'node'` (no `window`, no `document`) against
 * the published entry barrel, to prove:
 *   - the package imports with no top-level DOM access,
 *   - `flushOnHidden` degrades to a no-op rather than throwing,
 *   - and — the part that differs from a Vue-shaped library — that **the clock
 *     still runs here.** Node is a first-class target: a script batching writes
 *     to a database wants the interval. A server *render* does not, and says so
 *     with `autoFlush: false`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWriteBehind } from './writeBehind'
import type {
  WriteBehind,
  WriteBehindAttempt,
  WriteBehindFailure,
  WriteBehindOptions,
} from './writeBehind'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('no DOM', () => {
  it('has no DOM globals to accidentally touch', () => {
    expect(typeof globalThis.window).toBe('undefined')
    expect(typeof globalThis.document).toBe('undefined')
    expect(typeof createWriteBehind).toBe('function')
  })

  it('runs the whole cycle, tab-hidden flush and all', async () => {
    const rows: Record<string, string> = { A1: 'from-the-database' }
    const written: [string, string][] = []
    const wb = createWriteBehind(rows, {
      write: (value, key) => {
        written.push([key, value])
      },
      interval: 50,
    })

    rows.A1 = 'edited-in-node'
    wb.sync()
    expect(wb.pending).toEqual(['A1'])

    await vi.advanceTimersByTimeAsync(50)
    expect(written).toEqual([['A1', 'edited-in-node']])
    expect(wb.pending).toEqual([])

    wb.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never starts a timer under autoFlush: false — the server-render case', async () => {
    const rows: Record<string, string> = { A1: 'foo' }
    const written: string[] = []
    const wb = createWriteBehind(rows, {
      write: (value) => {
        written.push(value)
      },
    })
    wb.dispose()

    const parked = createWriteBehind(rows, {
      write: (value) => {
        written.push(value)
      },
      autoFlush: false,
    })

    rows.A1 = 'edited-during-the-render'
    parked.sync()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60000)
    expect(written).toEqual([])

    // The edit is not dropped — it sits in this engine's outbox and goes
    // nowhere. That queue is a closure: nothing serialises it, so a render's
    // edits do not reach a client. Put them in your own payload if you need
    // them.
    expect(parked.pending).toEqual(['A1'])
    parked.dispose()
  })

  it('exposes the public types', () => {
    const options: WriteBehindOptions<string> = { write: () => undefined, interval: 250 }
    const failure: WriteBehindFailure = { key: 'A1', error: undefined, attempts: 0, retryAt: 1 }
    const attempt: WriteBehindAttempt = { reason: 'unload', final: true, attempt: 1 }
    const wb: WriteBehind<string> = createWriteBehind<string>({}, options)

    expect(failure.key).toBe('A1')
    expect(attempt.final).toBe(true)
    expect(wb.isSyncing).toBe(false)
    wb.dispose()
  })

  /**
   * `pagehide` and `pageshow` are window events, so the hook now reaches for a
   * second global that is not here. Both listeners have to be skipped together
   * — a half-subscribed engine would throw on construction, which is the one
   * thing a server render cannot survive.
   */
  it('subscribes to nothing when there is no window either', async () => {
    const rows: Record<string, string> = { A1: 'foo' }
    const written: string[] = []
    const wb = createWriteBehind(rows, {
      write: (value) => {
        written.push(value)
      },
      autoFlush: false,
      flushOnHidden: true,
    })

    rows.A1 = 'edited'
    wb.sync()

    // Nothing to fire the unload flush, but the flush itself still works here:
    // it is the *listener* that has no home in Node, not the send.
    await wb.flush('unload')
    expect(written).toEqual(['edited'])

    wb.dispose()
  })
})
