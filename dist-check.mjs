/**
 * The consumer's view: import the BUILT artifact (not `src/`) and drive real
 * cycles on real timers.
 *
 * `dist/` in this portfolio has gone stale silently three times, and every unit
 * suite here imports source — so this is the only thing that fails when the
 * tarball and the source disagree. Run it with `npm run check:dist`.
 *
 * Five passes:
 *   1. the full cycle in bare Node — no `window`, no `document`, and the clock
 *      still runs, because that is this package's whole claim over the Vue one;
 *   2. `autoFlush: false` — nothing leaves, nothing is lost, `flush()` still
 *      sends it, and the writer is told why it was called (the `keepalive`
 *      flag is a property name, which is exactly what a minifier gets wrong);
 *   3. the 0.1.0 data-loss regression: discard a key while its request is out,
 *      edit again, and check what the SERVER ends up holding;
 *   4. the CommonJS entry, `require`d, because `main` points at it;
 *   5. the flush on page-hide, against a fake DOM that dispatches for real —
 *      installed last, so the no-DOM claim above is checked before it exists.
 *
 * Every wait is a poll with a deadline, never a bare sleep sized to beat an
 * interval — the same box runs CI.
 */
import { createRequire } from 'node:module'
import { createWriteBehind } from './dist/writeBehind.min.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const check = (what, ok, detail = '') => results.push([what, ok, detail])

/** Poll until `predicate` holds. Returns false on timeout instead of throwing. */
const waitUntil = async (predicate, timeout = 5000, step = 5) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(step)
  }
  return predicate()
}

check('no DOM in this process', typeof window === 'undefined' && typeof document === 'undefined')

// ------------------------------------------------ pass 1: the cycle, in Node
{
  const cells = { A1: 'from-the-server' }
  const calls = []
  const seen = []
  const wb = createWriteBehind(cells, {
    write: (value, key) => {
      calls.push([key, value])
      return sleep(60)
    },
    interval: 50,
  })
  wb.subscribe(() => seen.push(wb.pending))

  wb.sync()
  check('the record it started with is seeded, not queued', wb.pending.length === 0)

  cells.A1 = 'a'
  cells.A1 = 'b'
  wb.sync()
  await waitUntil(() => wb.inFlight.length === 1)
  const inFlightDuringWrite = [...wb.inFlight]

  cells.A1 = 'typed-while-in-flight'
  wb.sync()
  await waitUntil(() => wb.pending.length === 0)

  console.log('requests sent :', JSON.stringify(calls))
  console.log('local value   :', cells.A1)

  check('two edits in one window went out as one request', calls.length === 2, `${calls.length} calls`)
  check('the request carried the newest value in its window', calls[0]?.[1] === 'b')
  check('the key was in flight while the request was out', inFlightDuringWrite.length === 1)
  check('the edit made during the flight went out next', calls[1]?.[1] === 'typed-while-in-flight')
  check('the response never touched local state', cells.A1 === 'typed-while-in-flight')
  check('everything settled', wb.pending.length === 0 && wb.failed.length === 0)
  check('subscribers were called', seen.length > 0, `${seen.length} notifications`)
  check(
    'an unchanged pending set keeps its identity',
    new Set(seen.filter((keys) => keys.length === 1)).size === 1,
  )

  wb.dispose()
  check('dispose() is idempotent', (wb.dispose(), wb.dispose(), true))
}

// --------------------------------------------------- pass 2: autoFlush: false
{
  const cells = { A1: 'foo' }
  const calls = []
  const attempts = []
  const wb = createWriteBehind(cells, {
    write: (value, _key, attempt) => {
      calls.push(value)
      attempts.push(attempt)
    },
    autoFlush: false,
    interval: 20,
  })

  cells.A1 = 'edited-with-the-clock-off'
  wb.sync()
  await sleep(150)

  check('autoFlush: false sends nothing on its own', calls.length === 0)
  check('autoFlush: false still queues the edit', wb.pending.length === 1)

  await wb.flush()
  check('flush() sends it anyway', calls[0] === 'edited-with-the-clock-off', JSON.stringify(calls))
  check('and the key is clean afterwards', wb.pending.length === 0)

  // The third argument is the only reason a consumer's fetch can set
  // `keepalive`, and a minifier renaming a property would break it silently.
  check(
    'the writer is told why it was called',
    attempts[0]?.reason === 'manual' && attempts[0]?.final === false && attempts[0]?.attempt === 1,
    JSON.stringify(attempts[0]),
  )

  cells.A1 = 'the-last-thing-typed'
  await wb.flush('unload')
  check(
    "flush('unload') marks the attempt final",
    attempts[1]?.reason === 'unload' && attempts[1]?.final === true,
    JSON.stringify(attempts[1]),
  )
  check('and it carried the newest value', calls[1] === 'the-last-thing-typed', JSON.stringify(calls))
  wb.dispose()
}

// ------------------------------------------- pass 3: discard() cannot lose a write
// 0.1.0: discard() deleted the only record that a request was in the air, so
// the next edit opened a second, concurrent one. The fast second landed first,
// the slow first landed last, and the server kept the OLDER value — with
// `pending: []` saying everything was saved.
{
  const cells = { A1: 'v0' }
  const applied = []
  let inAir = 0
  let maxInAir = 0
  let latency = 400 // the first request is slow, the rest are fast
  const wb = createWriteBehind(cells, {
    write: async (value) => {
      inAir += 1
      maxInAir = Math.max(maxInAir, inAir)
      const takes = latency
      latency = 20
      await sleep(takes)
      applied.push(value)
      inAir -= 1
    },
    interval: 50,
  })

  cells.A1 = 'v1-slow'
  wb.sync()
  await waitUntil(() => wb.inFlight.length === 1)

  wb.discard('A1')
  wb.set('A1', 'v2-fast')
  await waitUntil(() => wb.pending.length === 0 && inAir === 0)

  console.log('server applied:', JSON.stringify(applied))

  check('never two requests in the air for one key', maxInAir === 1, `max ${maxInAir}`)
  check(
    'the server ends up holding the newest value',
    applied[applied.length - 1] === 'v2-fast',
    JSON.stringify(applied),
  )
  check('local state is what was set', cells.A1 === 'v2-fast')
  wb.dispose()
}

// ------------------------------------------------------ pass 4: the CJS entry
{
  const require = createRequire(import.meta.url)
  const cjs = require('./dist/writeBehind.min.cjs')
  check('require() gets createWriteBehind', typeof cjs.createWriteBehind === 'function')

  const rows = { A1: 'foo' }
  const written = []
  const wb = cjs.createWriteBehind(rows, { write: (value) => written.push(value), interval: 20 })
  rows.A1 = 'from-commonjs'
  wb.sync()
  await waitUntil(() => wb.pending.length === 0)
  check('the CJS build runs the same cycle', written[0] === 'from-commonjs', JSON.stringify(written))
  wb.dispose()
}

// ------------------------------------------- pass 5: the flush on page-hide
// Node has no DOM, so this installs the smallest one that can *dispatch*: the
// engine subscribes to `visibilitychange` on `document` and to
// `pagehide`/`pageshow` on `window`, and a fake that only answers the first
// would hide a half-wired listener. Everything above ran before these globals
// existed, which is the honest order — the no-DOM claim is checked first.
{
  const fakeTarget = (extra = {}) => {
    const bag = new Map()
    return {
      ...extra,
      addEventListener: (type, fn) => bag.set(type, [...(bag.get(type) ?? []), fn]),
      removeEventListener: (type, fn) =>
        bag.set(type, (bag.get(type) ?? []).filter((listener) => listener !== fn)),
      dispatch: (type) => {
        for (const fn of bag.get(type) ?? []) fn()
      },
    }
  }
  globalThis.window = fakeTarget()
  globalThis.document = fakeTarget({ visibilityState: 'visible' })

  const cells = { A1: 'v0' }
  const sent = []
  const wb = createWriteBehind(cells, {
    write: (value, _key, attempt) => sent.push({ value, attempt }),
    interval: 30000, // nothing leaves on the clock during this pass
    debounce: 5000, // …and the quiet period is still running when the page dies
  })

  cells.A1 = 'typed-just-before-the-refresh'
  wb.sync()
  await sleep(50)
  check('nothing went out on the clock', sent.length === 0)

  globalThis.window.dispatch('pagehide')
  await waitUntil(() => sent.length > 0)

  check(
    'pagehide flushed the keystroke the debounce was holding',
    sent[0]?.value === 'typed-just-before-the-refresh',
    JSON.stringify(sent),
  )
  check(
    'and the writer was told the page is going away',
    sent[0]?.attempt?.reason === 'unload' && sent[0]?.attempt?.final === true,
    JSON.stringify(sent[0]?.attempt),
  )

  globalThis.document.visibilityState = 'hidden'
  globalThis.document.dispatch('visibilitychange')
  await sleep(50)
  check('visibilitychange behind it does not send a second', sent.length === 1, `${sent.length} sent`)

  wb.dispose()
  delete globalThis.window
  delete globalThis.document
}

for (const [what, ok, detail] of results) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? `  — ${detail}` : ''}`)
}
const failed = results.filter(([, ok]) => !ok).length
console.log(failed === 0 ? '\nDIST CHECK: PASS' : `\nDIST CHECK: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
