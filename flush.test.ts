/**
 * The two writer adapters, driven straight against a real outbox with a fake
 * network. No timers — `now` is injected.
 */
import { describe, expect, it, vi } from 'vitest'
import { createOutbox } from './src/outbox'
import { createFlusher } from './src/flush'
import type { WriteBehindAttempt, WriteBehindBatchWriter, WriteBehindWriter } from './src/types'
import type { Deferred } from './test-utils'
import { deferred, microtasks } from './test-utils'

/** Fake network with one controllable request per key. */
const gates = (...keys: string[]) => {
  const map = new Map<string, Deferred<void>>(keys.map((key) => [key, deferred()]))
  const gate = (key: string): Deferred<void> => {
    const found = map.get(key)
    if (!found) throw new Error(`test gate missing for "${key}"`)
    return found
  }
  return { gate, promiseFor: (key: string) => gate(key).promise }
}

const setup = <T>(
  writer: { write: WriteBehindWriter<T> } | { flush: WriteBehindBatchWriter<T> },
  now = () => 0,
) => {
  const outbox = createOutbox<T>({ retryDelay: () => 1000 })
  const flusher = createFlusher<T>({ outbox, writer, now })
  return { outbox, flusher }
}

describe('flush — per-key writer', () => {
  it('sends one request per due key with the value read at send time', async () => {
    const write = vi.fn<WriteBehindWriter<string>>(() => Promise.resolve())
    const { outbox, flusher } = setup<string>({ write })

    outbox.set('A1', 'first')
    outbox.set('A1', 'second')
    outbox.set('B2', 'b')
    flusher.dispatch()
    await microtasks()

    expect(write.mock.calls.map(([value, key]) => [value, key])).toEqual([
      ['second', 'A1'],
      ['b', 'B2'],
    ])
    expect(outbox.pendingKeys()).toEqual([])
  })

  it('does not call the writer when nothing is due', () => {
    const write = vi.fn<WriteBehindWriter<string>>()
    const { flusher } = setup<string>({ write })

    flusher.dispatch()

    expect(write).not.toHaveBeenCalled()
  })

  it('records a rejection against its own key and leaves it pending', async () => {
    const failure = new Error('503')
    const { outbox, flusher } = setup<string>({ write: () => Promise.reject(failure) })

    outbox.set('A1', 'a')
    flusher.dispatch()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['A1'])
    expect(outbox.failures(0)[0]?.error).toBe(failure)
  })

  it('catches a writer that throws synchronously', async () => {
    const { outbox, flusher } = setup<string>({
      write: () => {
        throw new Error('bad url')
      },
    })

    outbox.set('A1', 'a')
    expect(() => flusher.dispatch()).not.toThrow()
    await microtasks()

    expect(outbox.failures(0)[0]?.attempts).toBe(1)
  })

  it('lets one key fail without touching its siblings (a try/catch per request)', async () => {
    const net = gates('A1', 'B2')
    const { outbox, flusher } = setup<string>({ write: (_value, key) => net.promiseFor(key) })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()

    net.gate('A1').reject(new Error('503'))
    net.gate('B2').resolve()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['A1'])
    expect(outbox.failures(0).map((f) => f.key)).toEqual(['A1'])
  })

  it('settles each key as its own request returns, not when the slowest does', async () => {
    const net = gates('A1', 'B2')
    const { outbox, flusher } = setup<string>({ write: (_value, key) => net.promiseFor(key) })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()

    net.gate('B2').resolve()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['A1'])
    expect(outbox.inFlightKeys()).toEqual(['A1'])
  })

  it('ignores whatever the writer resolves with — the response never comes back', async () => {
    const { outbox, flusher } = setup<string>({
      write: () => Promise.resolve({ value: 'server-says-this' }),
    })

    outbox.set('A1', 'local')
    flusher.dispatch()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual([])
  })
})

describe('flush — batch writer', () => {
  it('sends every due key as one call', async () => {
    const flushAll = vi.fn<WriteBehindBatchWriter<string>>(() => Promise.resolve())
    const { outbox, flusher } = setup<string>({ flush: flushAll })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()
    await microtasks()

    expect(flushAll).toHaveBeenCalledTimes(1)
    expect(flushAll.mock.calls[0]?.[0]).toEqual([
      ['A1', 'a'],
      ['B2', 'b'],
    ])
    expect(outbox.pendingKeys()).toEqual([])
  })

  it('keeps the whole batch pending when the call throws', async () => {
    const { outbox, flusher } = setup<string>({ flush: () => Promise.reject(new Error('500')) })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['A1', 'B2'])
    expect(outbox.failures(0).map((f) => f.attempts)).toEqual([1, 1])
  })

  it('fails only the keys the call reports', async () => {
    const { outbox, flusher } = setup<string>({ flush: () => Promise.resolve({ failed: ['B2'] }) })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['B2'])
    expect(outbox.failures(0)[0]?.key).toBe('B2')
  })

  it('applies the version guard per key inside a batch', async () => {
    const gate = deferred()
    const { outbox, flusher } = setup<string>({ flush: () => gate.promise })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()
    outbox.set('A1', 'typed-during-the-batch')
    gate.resolve()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['A1'])
    expect(outbox.take(0)[0]?.value).toBe('typed-during-the-batch')
  })

  it('treats a void result as "all written"', async () => {
    const { outbox, flusher } = setup<string>({ flush: () => undefined })

    outbox.set('A1', 'a')
    flusher.dispatch()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual([])
  })
})

describe('flush — dispatch clocks', () => {
  it('respects a key that is not due yet', () => {
    const write = vi.fn<WriteBehindWriter<string>>()
    const { outbox, flusher } = setup<string>({ write }, () => 500)

    outbox.set('A1', 'a', 900)
    flusher.dispatch()

    expect(write).not.toHaveBeenCalled()
  })

  it('flush() ignores the clock and resolves once the requests it started settle', async () => {
    const gate = deferred()
    const write = vi.fn<WriteBehindWriter<string>>(() => gate.promise)
    const { outbox, flusher } = setup<string>({ write }, () => 500)

    outbox.set('A1', 'a', 90000)
    let settled = false
    const done = flusher.flush().then(() => {
      settled = true
    })

    expect(write).toHaveBeenCalledTimes(1)
    await microtasks()
    expect(settled).toBe(false)

    gate.resolve()
    await done

    expect(settled).toBe(true)
    expect(outbox.pendingKeys()).toEqual([])
  })

  it('flush() waits for a flight that was already in the air', async () => {
    const gate = deferred()
    const { outbox, flusher } = setup<string>({ write: () => gate.promise })

    outbox.set('A1', 'a')
    flusher.dispatch()

    let settled = false
    const done = flusher.flush().then(() => {
      settled = true
    })
    await microtasks()
    expect(settled).toBe(false)

    gate.resolve()
    await done
    expect(settled).toBe(true)
  })

  it('flush() with nothing queued resolves immediately', async () => {
    const write = vi.fn<WriteBehindWriter<string>>()
    const { flusher } = setup<string>({ write })

    await expect(flusher.flush()).resolves.toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })
})

/**
 * The third argument to a writer — the one thing that lets a consumer's own
 * `fetch` set `keepalive`, since this library owns no transport.
 */
describe('flush — the attempt handed to the writer', () => {
  /** The attempt object the n-th call received. */
  const attemptOf = (write: { mock: { calls: unknown[][] } }, n = 0): WriteBehindAttempt =>
    write.mock.calls[n]?.[2] as WriteBehindAttempt

  it('a two-argument writer is still a writer', async () => {
    const seen: [string, string][] = []
    const { outbox, flusher } = setup<string>({
      write: (value, key) => {
        seen.push([key, value])
      },
    })

    outbox.set('A1', 'a')
    flusher.dispatch()
    await microtasks()

    expect(seen).toEqual([['A1', 'a']])
  })

  it('describes a clock tick as scheduled and not final', async () => {
    const write = vi.fn<WriteBehindWriter<string>>(() => Promise.resolve())
    const { outbox, flusher } = setup<string>({ write })

    outbox.set('A1', 'a')
    flusher.dispatch()
    await microtasks()

    expect(attemptOf(write)).toEqual({ reason: 'scheduled', final: false, attempt: 1 })
  })

  it('describes flush() as manual and not final', async () => {
    const write = vi.fn<WriteBehindWriter<string>>(() => Promise.resolve())
    const { outbox, flusher } = setup<string>({ write })

    outbox.set('A1', 'a')
    await flusher.flush()

    expect(attemptOf(write)).toEqual({ reason: 'manual', final: false, attempt: 1 })
  })

  it('describes the unload flush as final — the flag keepalive hangs off', async () => {
    const write = vi.fn<WriteBehindWriter<string>>(() => Promise.resolve())
    const { outbox, flusher } = setup<string>({ write })

    outbox.set('A1', 'a')
    await flusher.flush('unload')

    expect(attemptOf(write)).toEqual({ reason: 'unload', final: true, attempt: 1 })
  })

  it('counts the try, not the failures: 1, then 2, then 3', async () => {
    const write = vi.fn<WriteBehindWriter<string>>(() => Promise.reject(new Error('503')))
    const { outbox, flusher } = setup<string>({ write })

    outbox.set('A1', 'a')
    for (const _ of [0, 1, 2]) {
      flusher.dispatch('manual')
      await microtasks()
    }

    expect([0, 1, 2].map((n) => attemptOf(write, n).attempt)).toEqual([1, 2, 3])
  })

  it('gives the batch writer the highest attempt in the batch', async () => {
    const flushAll = vi.fn<WriteBehindBatchWriter<string>>(() =>
      Promise.resolve({ failed: ['A1'] }),
    )
    const { outbox, flusher } = setup<string>({ flush: flushAll })

    outbox.set('A1', 'a')
    flusher.dispatch('manual') // A1 goes out once and comes back failed
    await microtasks()
    outbox.set('B2', 'b') // a first-timer joins it
    flusher.dispatch('manual')
    await microtasks()

    expect(flushAll.mock.calls[1]?.[1]).toEqual({ reason: 'manual', final: false, attempt: 2 })
  })

  it('is still an unload when the batch writer is the one sending it', async () => {
    const flushAll = vi.fn<WriteBehindBatchWriter<string>>(() => Promise.resolve())
    const { outbox, flusher } = setup<string>({ flush: flushAll })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    await flusher.flush('unload')

    expect(flushAll).toHaveBeenCalledTimes(1)
    expect(flushAll.mock.calls[0]?.[1]).toEqual({ reason: 'unload', final: true, attempt: 1 })
  })
})
