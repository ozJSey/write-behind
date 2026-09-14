/**
 * The engine end to end: a real record, a real clock (faked) and a fake network
 * of deferred promises the test settles by hand.
 *
 * The invariants themselves are pinned far more cheaply in `outbox.test.ts`;
 * what is proved here is everything that sits *between* the record and the
 * outbox — the shadow diff, the `keys` filter, `equals`, the debounce clock,
 * the snapshots, the subscriber list and disposal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWriteBehind } from './src/createWriteBehind'
import type {
  WriteBehind,
  WriteBehindAttempt,
  WriteBehindOptions,
  WriteBehindWriter,
} from './src/types'
import type { Deferred } from './test-utils'
import { deferred, microtasks } from './test-utils'

const disposables: { dispose: () => void }[] = []

/** Build an engine and make sure the suite cannot leave its timer running. */
function engine<T>(
  source: Record<string, T> | (() => Record<string, T>),
  writerOrOptions: WriteBehindOptions<T> | WriteBehindWriter<T>,
): WriteBehind<T> {
  const wb = createWriteBehind<T>(source, writerOrOptions)
  disposables.push(wb)
  return wb
}

/** A writer whose every call the test settles individually. */
function fakeNetwork() {
  const calls: {
    value: unknown
    key: string
    at: number
    attempt: WriteBehindAttempt
  }[] = []
  const gates: Deferred<void>[] = []
  const write = (value: unknown, key: string, attempt: WriteBehindAttempt): Promise<void> => {
    calls.push({ value, key, at: Date.now(), attempt })
    const gate = deferred()
    gates.push(gate)
    return gate.promise
  }
  return {
    write,
    calls,
    gates,
    values: () => calls.map((call) => call.value),
    keys: () => calls.map((call) => call.key),
    times: () => calls.map((call) => call.at),
    reasons: () => calls.map((call) => call.attempt.reason),
    finals: () => calls.map((call) => call.attempt.final),
    attempts: () => calls.map((call) => call.attempt.attempt),
  }
}

/** Run the flush clock for `ms`, then let every promise chain settle. */
async function tick(ms = 1000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await microtasks()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  for (const wb of disposables.splice(0)) wb.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the bare form — no options', () => {
  it('collapses N edits into one request carrying the newest value', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    for (const value of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      cells.A1 = value
      wb.sync()
    }
    await tick()

    expect(net.calls).toHaveLength(1)
    expect(net.values()).toEqual(['j'])
  })

  it('seeds what the record starts with instead of queueing it', async () => {
    const cells: Record<string, string> = { A1: 'from-the-server', B2: 'also' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    wb.sync()
    await tick()

    expect(net.calls).toEqual([])
    expect(wb.pending).toEqual([])
  })

  it('waits a full interval rather than firing on the first edit', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    expect(net.calls).toEqual([])

    await tick(999)
    expect(net.calls).toEqual([])

    await tick(1)
    expect(net.values()).toEqual(['edited'])
  })

  it('never overwrites local state with the response', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const wb = engine(cells, () => Promise.resolve('WHATEVER-THE-SERVER-SAYS'))

    cells.A1 = 'mine'
    wb.sync()
    await tick()

    expect(cells.A1).toBe('mine')
  })

  it('accepts a getter, so the record itself can be replaced', async () => {
    let cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(() => cells, net.write)

    cells = { A1: 'foo', B2: 'new object entirely' }
    wb.sync()
    await tick()

    expect(net.calls).toMatchObject([{ value: 'new object entirely', key: 'B2', at: 1000 }])
  })
})

describe('sync()', () => {
  it('is idempotent — a second call with nothing moved queues nothing', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    wb.sync()
    wb.sync()
    expect(wb.pending).toEqual(['A1'])

    await tick()
    expect(net.calls).toHaveLength(1)

    net.gates[0]?.resolve()
    await microtasks()
    wb.sync()
    await tick()

    expect(net.calls).toHaveLength(1)
    expect(wb.pending).toEqual([])
  })

  it('notifies once for a bulk edit, not once per key', () => {
    const cells: Record<string, string> = {}
    const wb = engine(cells, () => Promise.resolve())
    let notifications = 0
    wb.subscribe(() => {
      notifications += 1
    })

    for (let index = 0; index < 200; index += 1) cells[`K${index}`] = 'x'
    wb.sync()

    expect(wb.pending).toHaveLength(200)
    expect(notifications).toBe(1)
  })

  it('keeps a queued write for a key deleted from the record', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited-then-removed'
    wb.sync()
    delete cells.A1
    wb.sync()

    expect(wb.pending).toEqual(['A1'])
    await tick()
    expect(net.values()).toEqual(['edited-then-removed'])
  })

  it('counts a deleted key put back as a fresh edit, even at its old value', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    delete cells.A1
    wb.sync()
    cells.A1 = 'foo'
    wb.sync()

    expect(wb.pending).toEqual(['A1'])
    await tick()
    expect(net.values()).toEqual(['foo'])
  })
})

describe('the keys filter', () => {
  it('narrows what sync() picks up — allow-list form', async () => {
    const cells: Record<string, string> = { A1: 'a', B2: 'b' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, keys: ['A1'] })

    cells.A1 = 'a-edited'
    cells.B2 = 'b-edited'
    wb.sync()
    await tick()

    expect(net.keys()).toEqual(['A1'])
  })

  it('narrows what sync() picks up — predicate form', async () => {
    const cells: Record<string, string> = { 'draft:1': 'a', published: 'b' }
    const net = fakeNetwork()
    const wb = engine(cells, {
      write: net.write,
      keys: (key) => key.startsWith('draft:'),
    })

    cells['draft:1'] = 'a-edited'
    cells.published = 'b-edited'
    wb.sync()
    await tick()

    expect(net.keys()).toEqual(['draft:1'])
  })

  it('does not seed an excluded key either, so including it later is an edit', async () => {
    const cells: Record<string, string> = { A1: 'from-the-server' }
    const net = fakeNetwork()
    let watched = false
    const wb = engine(cells, { write: net.write, keys: () => watched })

    wb.sync()
    expect(wb.pending).toEqual([])

    watched = true
    wb.sync()
    await tick()

    expect(net.values()).toEqual(['from-the-server'])
  })

  it('set() ignores the filter — it is the explicit escape hatch', async () => {
    const cells: Record<string, string> = { A1: 'a', B2: 'b' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, keys: ['A1'] })

    wb.set('B2', 'set-explicitly')
    await tick()

    expect(cells.B2).toBe('set-explicitly')
    expect(net.keys()).toEqual(['B2'])
  })
})

describe('equals', () => {
  it('short-circuits a value the comparator calls unchanged', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, {
      write: net.write,
      equals: (a, b) => a.toLowerCase() === b.toLowerCase(),
    })

    cells.A1 = 'FOO'
    wb.sync()
    await tick()
    expect(net.calls).toEqual([])

    cells.A1 = 'bar'
    wb.sync()
    await tick()
    expect(net.values()).toEqual(['bar'])
  })

  it('defaults to Object.is, so an object mutated in place is not an edit', async () => {
    const cells: Record<string, { text: string }> = { A1: { text: 'foo' } }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1!.text = 'mutated in place'
    wb.sync()
    await tick()
    expect(net.calls).toEqual([])

    // The documented escape hatch: set() always queues.
    wb.set('A1', cells.A1!)
    await tick()
    expect(net.values()).toEqual([{ text: 'mutated in place' }])
  })
})

describe('set()', () => {
  it('writes the record and queues in one call', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    wb.set('A1', 'both-at-once')

    expect(cells.A1).toBe('both-at-once')
    expect(wb.pending).toEqual(['A1'])
    await tick()
    expect(net.values()).toEqual(['both-at-once'])
  })

  it('does not make the following sync() queue the same edit twice', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    wb.set('A1', 'once')
    wb.sync()
    await tick()

    expect(net.calls).toHaveLength(1)
  })
})

describe('flush()', () => {
  it('diffs the record first, so an edit made in the same breath still goes', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'typed-and-saved-at-once'
    const done = wb.flush()

    expect(net.values()).toEqual(['typed-and-saved-at-once'])
    net.gates[0]?.resolve()
    await done
    expect(wb.pending).toEqual([])
  })

  it('ignores the debounce clock', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, debounce: 60000 })

    cells.A1 = 'edited'
    const done = wb.flush()
    expect(net.values()).toEqual(['edited'])

    net.gates[0]?.resolve()
    await done
    expect(wb.pending).toEqual([])
  })

  it('revives a key parked by retry: false', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, retry: false })

    cells.A1 = 'edited'
    wb.sync()
    await tick()
    net.gates[0]?.reject(new Error('503'))
    await microtasks()

    expect(wb.failed[0]?.retryAt).toBeUndefined()
    await tick(60000)
    expect(net.calls).toHaveLength(1)

    void wb.flush()
    await microtasks()
    expect(net.calls).toHaveLength(2)
  })
})

/**
 * What the writer is told about the send it is being asked to make. The whole
 * point of it is `final`: this library owns no transport, so the one thing it
 * can do about a request outliving the page is say when that matters.
 */
describe('the attempt handed to the writer', () => {
  it('calls the clock\'s own flush scheduled, and not final', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    await tick()

    expect(net.reasons()).toEqual(['scheduled'])
    expect(net.finals()).toEqual([false])
  })

  it('calls flush() manual, and not final', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    void wb.flush()
    await microtasks()

    expect(net.reasons()).toEqual(['manual'])
    expect(net.finals()).toEqual([false])
  })

  it("flush('unload') is the escape hatch for an unload signal we refuse to listen to", async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, flushOnHidden: false })

    cells.A1 = 'edited'
    void wb.flush('unload')
    await microtasks()

    expect(net.reasons()).toEqual(['unload'])
    expect(net.finals()).toEqual([true])
  })

  it('counts the try for this key through the retry curve', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, interval: 100, retry: { initialDelay: 100 } })

    cells.A1 = 'edited'
    wb.sync()
    for (const index of [0, 1, 2]) {
      await tick(1000)
      net.gates[index]?.reject(new Error('503'))
      await microtasks()
    }

    expect(net.attempts()).toEqual([1, 2, 3])
  })

  it('starts the count over once a key lands', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, interval: 100 })

    cells.A1 = 'edited'
    wb.sync()
    await tick(100)
    net.gates[0]?.reject(new Error('503'))
    await microtasks()
    await tick(2000)
    net.gates[1]?.resolve()
    await microtasks()

    cells.A1 = 'edited again'
    wb.sync()
    await tick(100)

    expect(net.attempts()).toEqual([1, 2, 1])
  })

  /**
   * `final` is a promise about the *page*, not about the outbox. If the page
   * turns out to survive — a backgrounded tab that comes back — the key is
   * still queued and the normal retry curve still runs. A writer must not count
   * on that; the library must not pretend the write is gone either.
   */
  it('leaves a failed unload flush queued and retrying, if the page survives', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, interval: 100, retry: { initialDelay: 100 } })

    cells.A1 = 'edited'
    void wb.flush('unload')
    await microtasks()
    net.gates[0]?.reject(new Error('never left the socket'))
    await microtasks()

    expect(wb.pending).toEqual(['A1'])
    await tick(1000)
    expect(net.reasons()).toEqual(['unload', 'scheduled'])
  })
})

describe('the clocks', () => {
  it('interval sets the cadence', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, interval: 250 })

    cells.A1 = 'edited'
    wb.sync()
    await tick(250)

    expect(net.times()).toEqual([250])
  })

  it('debounce holds a key back until the edits stop', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, interval: 100, debounce: 500 })

    for (let index = 0; index < 4; index += 1) {
      cells.A1 = `edit-${index}`
      wb.sync()
      await tick(100)
    }
    expect(net.calls).toEqual([])

    await tick(500)
    expect(net.values()).toEqual(['edit-3'])
  })

  it('backs off 1 → 2 → 4 → 8 s after consecutive failures', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, interval: 100 })

    cells.A1 = 'edited'
    wb.sync()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await tick(100)
      net.gates[net.gates.length - 1]?.reject(new Error('503'))
      await microtasks()
      await tick(1000 * 2 ** attempt)
    }

    // Each retry is woken on its own deadline rather than rounded up to the
    // next 100ms tick: reject at t, next attempt at exactly t + the backoff.
    expect(net.times()).toEqual([100, 1100, 3200, 7300, 15400])
    expect(wb.failed[0]?.attempts).toBe(4)
  })

  it('holds no timer while nothing is queued', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)
    expect(vi.getTimerCount()).toBe(0)

    cells.A1 = 'edited'
    wb.sync()
    expect(vi.getTimerCount()).toBe(1)

    await tick()
    net.gates[0]?.resolve()
    await microtasks()

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('autoFlush: false', () => {
  it('queues, reports and never starts a timer', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, autoFlush: false })

    cells.A1 = 'edited'
    wb.sync()

    expect(wb.pending).toEqual(['A1'])
    expect(vi.getTimerCount()).toBe(0)

    await tick(60000)
    expect(net.calls).toEqual([])
  })

  it('still sends on an explicit flush()', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, autoFlush: false })

    cells.A1 = 'edited'
    const done = wb.flush()
    expect(net.values()).toEqual(['edited'])

    net.gates[0]?.resolve()
    await done
    expect(wb.pending).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('subscribe()', () => {
  it('fires after every transition, with the snapshots already refreshed', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)
    const seen: { pending: readonly string[]; inFlight: readonly string[] }[] = []
    wb.subscribe(() => seen.push({ pending: wb.pending, inFlight: wb.inFlight }))

    cells.A1 = 'edited'
    wb.sync()
    expect(seen).toEqual([{ pending: ['A1'], inFlight: [] }])

    await tick()
    expect(seen[seen.length - 1]).toEqual({ pending: ['A1'], inFlight: ['A1'] })

    net.gates[0]?.resolve()
    await microtasks()
    expect(seen[seen.length - 1]).toEqual({ pending: [], inFlight: [] })
  })

  it('stops calling a listener that has unsubscribed', () => {
    const cells: Record<string, string> = {}
    const wb = engine(cells, () => Promise.resolve())
    let calls = 0
    const unsubscribe = wb.subscribe(() => {
      calls += 1
    })

    wb.set('A1', 'a')
    expect(calls).toBe(1)

    unsubscribe()
    wb.set('A2', 'b')
    expect(calls).toBe(1)
  })

  it('feeds several listeners independently', () => {
    const wb = engine<string>({}, () => Promise.resolve())
    const calls: string[] = []
    const stopFirst = wb.subscribe(() => calls.push('first'))
    wb.subscribe(() => calls.push('second'))

    wb.set('A1', 'a')
    stopFirst()
    wb.set('A2', 'b')

    expect(calls).toEqual(['first', 'second', 'second'])
  })
})

describe('the snapshots', () => {
  it('keep their identity through a retry storm that changes nothing', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const wb = engine(cells, {
      write: () => Promise.reject(new Error('503')),
      interval: 100,
      retry: { initialDelay: 10, factor: 1 },
    })

    cells.A1 = 'edited'
    wb.sync()
    await tick(100)
    const pending = wb.pending

    for (let attempt = 0; attempt < 5; attempt += 1) await tick(100)

    expect(wb.pending).toBe(pending)
    expect(wb.pending).toEqual(['A1'])
    expect(wb.failed[0]?.attempts).toBeGreaterThan(1)
  })

  it('replace an array only when its contents move', async () => {
    const cells: Record<string, string> = { A1: 'a', B2: 'b' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    wb.set('A1', 'a-edited')
    const first = wb.pending
    wb.set('A1', 'a-again')
    expect(wb.pending).toBe(first)

    wb.set('B2', 'b-edited')
    expect(wb.pending).not.toBe(first)
    expect(wb.pending).toEqual(['A1', 'B2'])
  })

  it('publish a retryAt that is never in the past', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, interval: 100 })

    cells.A1 = 'edited'
    wb.sync()
    await tick(100)
    net.gates[0]?.reject(new Error('503'))
    await microtasks()

    const failure = wb.failed[0]
    expect(failure?.retryAt).toBe(1100)
    expect(failure?.retryAt).toBeGreaterThanOrEqual(Date.now())
  })
})

describe('dispose()', () => {
  it('stops the clock and sends nothing afterwards', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    wb.dispose()

    await tick(10000)
    expect(net.calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is idempotent', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    wb.dispose()
    wb.dispose()
    wb.dispose()

    await tick(10000)
    expect(net.calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cannot be undone by a response landing after it', async () => {
    // The regression: settle/fail notifies, `reschedule()` finds the key still
    // dirty because a newer edit arrived mid-flight, and a disposed engine
    // starts a brand new interval that writes forever.
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'first'
    wb.sync()
    await tick()
    expect(net.calls).toHaveLength(1)

    cells.A1 = 'typed-while-in-flight'
    wb.sync()
    wb.dispose()
    net.gates[0]?.resolve()
    await microtasks()

    await tick(10000)
    expect(net.calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    // Nothing is lost — it simply stops going out by itself.
    expect(wb.pending).toEqual(['A1'])
  })

  it('loses nothing: flush() still works on a disposed engine', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    wb.dispose()

    const done = wb.flush()
    expect(net.values()).toEqual(['edited'])
    net.gates[0]?.resolve()
    await done
    expect(wb.pending).toEqual([])
  })
})

/**
 * Two events, one flush. `visibilitychange → hidden` is backgrounding;
 * `pagehide` is a refresh, a same-tab navigation, a tab close — and on iOS
 * Safari, a swipe-away that never fires `visibilitychange` at all. Desktop
 * fires both for one teardown, so the pair has to de-duplicate.
 */
describe('flush when the page goes away', () => {
  /** `visibilitychange → hidden`, the backgrounding signal. */
  const hide = async (): Promise<void> => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await microtasks()
  }

  /** `visibilitychange → visible`: the tab came back. */
  const unhide = async (): Promise<void> => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await microtasks()
  }

  /** `pagehide`, fired at the window — refresh, navigation, iOS swipe-away. */
  const pagehide = async (): Promise<void> => {
    window.dispatchEvent(new Event('pagehide'))
    await microtasks()
  }

  /** `pageshow`: restored from the back/forward cache. */
  const pageshow = async (): Promise<void> => {
    window.dispatchEvent(new Event('pageshow'))
    await microtasks()
  }

  it('flushes on pagehide alone — the signal iOS Safari fires instead', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    await pagehide()

    expect(net.values()).toEqual(['edited'])
  })

  /**
   * The first attempt is *failed* on purpose. A key that is clean, or still on
   * the wire, would be skipped by the second flush whether or not the pair
   * de-duplicates — only a key sitting in its backoff can tell the two apart,
   * because a second flush forces it straight back out.
   */
  const editAndFailOnce = async (
    cells: Record<string, string>,
    net: ReturnType<typeof fakeNetwork>,
    wb: WriteBehind<string>,
    leave: () => Promise<void>,
  ): Promise<void> => {
    cells.A1 = 'edited'
    wb.sync()
    await leave()
    net.gates[0]?.reject(new Error('503'))
    await microtasks()
  }

  it('flushes once when the browser fires visibilitychange AND pagehide', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    await editAndFailOnce(cells, net, wb, hide)
    await pagehide()

    expect(net.calls).toHaveLength(1)
  })

  it('flushes once in the other order too', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    await editAndFailOnce(cells, net, wb, pagehide)
    await hide()

    expect(net.calls).toHaveLength(1)
  })

  it('re-arms when the tab comes back, so the next hide flushes again', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'first'
    wb.sync()
    await hide()
    net.gates[0]?.resolve()
    await microtasks()

    await unhide()
    cells.A1 = 'second'
    wb.sync()
    await hide()

    expect(net.values()).toEqual(['first', 'second'])
  })

  it('re-arms on pageshow — a page restored from the bfcache is live again', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'first'
    wb.sync()
    await pagehide()
    net.gates[0]?.resolve()
    await microtasks()

    await pageshow()
    cells.A1 = 'second'
    wb.sync()
    await pagehide()

    expect(net.values()).toEqual(['first', 'second'])
  })

  it('sends the keystroke the debounce is still holding', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, debounce: 5000 })

    cells.A1 = 'typed 200ms ago'
    wb.sync()
    await tick(200)
    expect(net.calls).toEqual([]) // the quiet period has four more seconds to run
    await pagehide()

    expect(net.values()).toEqual(['typed 200ms ago'])
  })

  it('reports reason: "unload" and final: true', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    await pagehide()

    expect(net.reasons()).toEqual(['unload'])
    expect(net.finals()).toEqual([true])
  })

  it('opts out of pagehide too with flushOnHidden: false', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, flushOnHidden: false })

    cells.A1 = 'edited'
    wb.sync()
    await pagehide()

    expect(net.calls).toEqual([])
  })

  it('drops the pagehide listener on dispose', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    wb.dispose()
    await pagehide()

    expect(net.calls).toEqual([])
  })

  it('flushes what is pending, without waiting for the interval', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    await hide()

    expect(net.values()).toEqual(['edited'])
  })

  it('diffs the record on the way out, so an unsynced edit is not lost', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    engine(cells, net.write)

    cells.A1 = 'never-synced'
    await hide()

    expect(net.values()).toEqual(['never-synced'])
  })

  it('ignores a visibilitychange that is not "hidden"', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    document.dispatchEvent(new Event('visibilitychange'))
    await microtasks()

    expect(net.calls).toEqual([])
  })

  it('opts out with flushOnHidden: false', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, flushOnHidden: false })

    cells.A1 = 'edited'
    wb.sync()
    await hide()

    expect(net.calls).toEqual([])
  })

  it('stops listening once disposed', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    wb.dispose()
    await hide()

    expect(net.calls).toEqual([])
  })
})

describe('retry() and discard()', () => {
  it('retry() clears the backoff so the key goes out on the next tick', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, interval: 100 })

    cells.A1 = 'edited'
    wb.sync()
    await tick(100)
    net.gates[0]?.reject(new Error('503'))
    await microtasks()
    expect(wb.failed).toHaveLength(1)

    wb.retry('A1')
    expect(wb.failed).toEqual([])
    await tick(100)

    expect(net.calls).toHaveLength(2)
  })

  it('discard() is the only thing that loses a write', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, net.write)

    cells.A1 = 'edited'
    wb.sync()
    expect(wb.pending).toEqual(['A1'])

    wb.discard('A1')
    expect(wb.pending).toEqual([])
    await tick()

    expect(net.calls).toEqual([])
    // Local state is untouched: discard drops the *write*, not the value.
    expect(cells.A1).toBe('edited')
  })

  it('holds a discarded key back until its request answers', async () => {
    const cells: Record<string, string> = { A1: 'foo' }
    const net = fakeNetwork()
    const wb = engine(cells, { write: net.write, interval: 100 })

    cells.A1 = 'v1-in-flight'
    wb.sync()
    await tick(100)
    expect(wb.inFlight).toEqual(['A1'])

    wb.discard('A1')
    cells.A1 = 'v2'
    wb.sync()
    await tick(500)

    expect(net.calls).toHaveLength(1)
    expect(wb.pending).toEqual(['A1'])
    expect(wb.inFlight).toEqual([])

    net.gates[0]?.resolve()
    await microtasks()
    await tick(100)

    expect(net.values()).toEqual(['v1-in-flight', 'v2'])
  })
})

describe('the batch writer', () => {
  it('sends every due key in one call', async () => {
    const cells: Record<string, string> = { A1: 'a', B2: 'b' }
    const calls: [string, string][][] = []
    const wb = engine(cells, {
      flush: (entries) => {
        calls.push(entries)
      },
    })

    cells.A1 = 'a-edited'
    cells.B2 = 'b-edited'
    wb.sync()
    await tick()

    expect(calls).toEqual([
      [
        ['A1', 'a-edited'],
        ['B2', 'b-edited'],
      ],
    ])
    expect(wb.pending).toEqual([])
  })

  it('fails only the keys the call names', async () => {
    const cells: Record<string, string> = { A1: 'a', B2: 'b' }
    const wb = engine(cells, { flush: () => ({ failed: ['B2'] }) })

    cells.A1 = 'a-edited'
    cells.B2 = 'b-edited'
    wb.sync()
    await tick()

    expect(wb.pending).toEqual(['B2'])
    expect(wb.failed.map((failure) => failure.key)).toEqual(['B2'])
    expect(String(wb.failed[0]?.error)).toContain('write-behind: batch flush reported "B2"')
  })
})

describe('typing', () => {
  it('infers the value type from the record', async () => {
    const counters: Record<string, number> = { visits: 1 }
    const seen: number[] = []
    const wb: WriteBehind<number> = engine(counters, (value) => {
      seen.push(value)
    })

    wb.set('visits', 2)
    await tick()

    expect(seen).toEqual([2])
  })
})
