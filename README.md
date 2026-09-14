# @ozjsey/write-behind

**A slow response cannot clear a newer edit.** That is the bug every naive write-behind ships, it is
invisible until a request is slow, and it is the reason this package exists.

Queue writes, coalesce them per key, send them on a clock, retry with backoff — in ~5 KB of plain
TypeScript with **zero dependencies**, no peer dependencies and no framework. It runs in the
browser, in Node, in a worker.

```ts
import { createWriteBehind } from '@ozjsey/write-behind'

const cells: Record<string, string> = { A1: 'foo' }

const wb = createWriteBehind(cells, (value, key) => api.put(`/cell/${key}`, value))

cells.A1 = 'bar'
wb.sync()             // "I changed the record" — diff it and queue what moved
wb.set('A1', 'bar')   // or do both in one call, skipping the diff
```

Local state stays authoritative and the network is a background chore. Edit a key ten times and one
request goes out carrying the tenth value. The server's reply is *discarded on purpose* — it can
never overwrite the value the user is still typing. A failed save rolls nothing back; the key stays
dirty and goes out again next tick, carrying whatever has been typed since.

It is a **state outbox, not an operation log**: keys are independent and last-write-wins.

See it in action: [npm portfolio playground](https://ozjsey.github.io/npm-portfolio-playground/) —
the [write-behind cards](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind) drive
this engine through its Vue adapter, and
[**the cell does not jump**](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/no-jump)
is the whole claim in one card: type into a cell while a slow server is answering, and watch the
field not move.

```bash
npm install @ozjsey/write-behind
```

Using Vue? [`@ozjsey/vue-write-behind`](https://www.npmjs.com/package/@ozjsey/vue-write-behind) is
this engine with the `sync()` call wired to Vue's reactivity and the state mirrored into a reactive
store. Everything below still applies; you just never call `sync()` yourself.

## The claim, spelled out

A key is edited while its own save is in flight. This is the case a boolean dirty flag gets wrong:

```
t=0    user types "hello"      → queued, dirty
t=50   request leaves with "hello"
t=60   user types "hello!"     → still dirty, newer value
t=900  the t=50 response lands → "saved!" → dirty flag cleared
```

`"hello!"` is now gone. It is on screen, it looks correct, nothing errored, and the server holds
`"hello"` forever.

Here each key carries a **monotonic version**, a request records the version it was sent at, and a
success clears the key **only if** the version has not moved:

```ts
if (entry.version === sentVersion) entries.delete(key)   // nothing was typed while it was out
else { /* keep it dirty; send the newer value next tick */ }
```

Three things follow, and they are the rest of the package:

- **A retry sends the current value, not the one that failed.** The value is read out of the queue
  at send time, never captured when the edit happened. A save that failed at 09:00 and retries at
  09:01 carries what is on screen at 09:01.
- **One request per key at a time.** A key already in flight is skipped even when it is dirty, so
  two requests for one key can never race and land out of order. What is on the wire is tracked
  separately from what is queued, so this survives `discard(key)` too.
- **Failure never rolls back.** Not local state, not the queue. `discard(key)` is the only operation
  here that loses a write, and you have to call it.

## `sync()` — the one thing you have to do

A plain object cannot announce that it changed. There is no proxy here and no observer, which is
what keeps this package framework-free — so after you mutate the record, say so:

```ts
cells.A1 = 'bar'
wb.sync()            // diff the record, queue what moved
```

`sync()` is idempotent and cheap when nothing has moved: it is a walk of the record, not a request.
Call it at the end of whatever changed the data, in an input handler, or from a framework's change
signal. If that is too much bookkeeping, `wb.set('A1', 'bar')` writes the value into the record
**and** queues it in one call — and, unlike `sync()`, it queues unconditionally, which is the escape
hatch for a value `equals` cannot see and for keys `keys` filters out.

Pass a **getter** when the record object itself can be replaced:

```ts
let rows = await load()
const wb = createWriteBehind(() => rows, save)
rows = await reload()   // a whole new object
wb.sync()               // still diffed correctly
```

## What the defaults do

The bare form above is the configuration this library recommends — options exist to opt *out*.

| | Default | Why |
|---|---|---|
| Cadence | flush every **1000 ms**, and the timer only runs while something is queued | a burst of edits is one request; an idle process holds no timer |
| Coalescing | last-write-wins per key | the queue is bounded by the number of keys, not edits |
| Parallelism | one request per due key, each in its own `try`/`catch` | keys are independent, so one slow key never holds up another, and one rejection never fails a sibling |
| The response | **ignored** — there is no opt-in | applying it is the "the value jumps while you type" bug |
| Failure | retry forever, per-key backoff 1 → 2 → 4 → 8 → 16 → 30 s (capped), timed to the millisecond rather than rounded up to the next tick, always re-sending the **current** value | silently dropping an edit is the one unacceptable outcome |
| Batch size | unlimited | |
| Leaving the page | flush on `visibilitychange → hidden` **and** `pagehide`, de-duplicated into one, where there is a `document` | a refresh and an iOS swipe-away are not the same event — see below |
| Environment | the clock runs in Node exactly as it does in a browser | Node is a target, not a degraded browser |

## What it returns

| | |
|---|---|
| `pending` | every key with an unsaved change, in-flight ones included. The "you have unsaved work" number |
| `inFlight` | the subset whose own write is currently on the wire (a key waiting behind a *discarded* write's request is not in it) |
| `failed` | `{ key, error, attempts, retryAt }` per failing key — latest error only. `retryAt` is never in the past, and is `undefined` only when no automatic attempt is scheduled (`retry: false`) |
| `isSyncing` | `true` while anything is in flight |
| `set(key, value)` | write the record **and** queue it, unconditionally |
| `sync()` | diff the record against what was last seen and queue what moved. Idempotent |
| `flush()` | `sync()`, then send every pending key now — ignoring the debounce, the backoff and `retry: false`'s parked state. The one thing it cannot send is a key already on the wire. Resolving is not proof of success: read `pending` / `failed` afterwards. `flush('unload')` tells the writer the page is going away |
| `retry(key?)` | clear the backoff and the recorded failure for one key, or all |
| `discard(key)` | drop a pending write. **The only operation here that loses one.** A request already on the wire cannot be recalled — the key is held back until it answers |
| `subscribe(fn)` | call `fn` after every transition. Returns the unsubscribe |
| `dispose()` | stop the clock and drop the page-hidden listeners. Idempotent, and it loses nothing — queued writes stay queued and `flush()` still sends them |

The four state members are **snapshot getters**, not live arrays: reading one gives the value as of
the last transition, and **its identity does not change while its contents do not**. So a subscriber
can skip a no-op with one `!==`:

```ts
let last = wb.pending
wb.subscribe(() => {
  if (wb.pending === last) return   // a retry storm changed nothing
  last = wb.pending
  render(last)
})
```

## Options

Every one is an opt-out. Pass them instead of the bare writer:

```ts
const wb = createWriteBehind(cells, {
  write: (value, key) => api.put(`/cell/${key}`, value),
  interval: 1000,
  debounce: 0,
  retry: { initialDelay: 1000, maxDelay: 30000, factor: 2 }, // or `false`
  flushOnHidden: true,
  autoFlush: true,
  keys: ['A1', 'A2'],          // or (key) => key.startsWith('draft:')
  equals: (a, b) => a === b,
})
```

- **`interval`** — flush cadence in ms. It is a fixed window, not a debounce: it never restarts
  under a fast editor. It does not quantise the other clocks — a `debounce` or a retry backoff that
  falls between two ticks is woken for on its own deadline — and the timer only runs while a key is
  actually eligible.
- **`debounce`** — per-key quiet period before a key becomes eligible. Off by default because the
  interval already coalesces a burst. It is your clock: only an edit moves it, and a response
  landing mid-typing, a failure, or `retry()` cannot cut it short. It is tracked separately from the
  retry backoff, so neither shortens the other and a key waits for whichever is later.
- **`retry: false`** — stop retrying after a failure. The key is **not** dropped: it stays in
  `pending`, stays listed in `failed` with `retryAt: undefined`, and goes out again on the next
  edit, on `retry(key)`, or on `flush()` — including the automatic flush when the tab is hidden.
- **`flushOnHidden`** — flush when the page goes away, on either signal the browser gives
  (`visibilitychange → hidden`, `pagehide`), de-duplicated into one flush. A no-op where there is no
  `document`, so there is nothing to turn off in Node. See
  [surviving a page refresh](#surviving-a-page-refresh--keepalive).
- **`autoFlush: false`** — do not run the clock at all. Edits still queue, `pending` still reports
  them and `flush()` still sends them; only the automatic cadence is off. Use it when timers are
  unwelcome or pointless: a server-side render whose response a live interval would hold open, or a
  process that decides its own cadence.
- **`keys`** — narrows what `sync()` picks up. `set()` is explicit and ignores it.
- **`equals`** — change detection, `Object.is` by default. See the preconditions below.

### A batch endpoint

The other shape worth first-class support. One call per tick, every due key in it:

```ts
createWriteBehind(cells, {
  flush: (entries) => api.patch('/cells', Object.fromEntries(entries)),
})
```

Throw or reject and the **whole batch** stays pending. Resolve with `{ failed: ['A1'] }` to fail
part of it — everything else in the batch is treated as written. The version guard is applied per
key inside the batch, exactly as it is per request.

## Surviving a page refresh — `keepalive`

When the page goes away this library flushes: `visibilitychange → hidden` **and** `pagehide`,
de-duplicated so a browser firing both sends one request rather than two. Taking both matters —
`visibilitychange` is backgrounding, `pagehide` is a refresh, a same-tab navigation or a tab close,
and on iOS Safari a swipe-away fires `pagehide` and nothing else. `beforeunload` is deliberately not
used: mobile browsers routinely discard a page without ever firing it, and registering one costs the
back/forward cache.

That flush is **forced** — it ignores the debounce clock, the retry backoff and `retry: false` — so
it carries the character typed 200 ms before the tab closed.

What it cannot do is make the request outlive the page. Only the request can do that, and the
request is yours. So the writer is told which kind of send this is:

```ts
createWriteBehind(cells, (value, key, { final }) =>
  fetch(`/cell/${key}`, {
    method: 'PUT',
    body: JSON.stringify(value),
    keepalive: final,        // the browser finishes this one after the page is gone
  }),
)
```

`{ reason, final, attempt }` is a `WriteBehindAttempt`. A two-argument writer stays a perfectly good
writer — the parameter is additive and every existing one keeps working.

| | |
|---|---|
| `reason` | `'scheduled'` (the clock), `'manual'` (your `flush()`), `'unload'` (the page is going away) |
| `final` | `true` exactly when `reason` is `'unload'`. The only question most writers ask |
| `attempt` | `1` on the first try for this key, `2` after one failure. For an idempotency key, or your own give-up rule. A batch writer gets the highest number in its batch |

### `sendBeacon`, for a POST endpoint

```ts
createWriteBehind(cells, {
  flush: (entries, { final }) => {
    const body = JSON.stringify(Object.fromEntries(entries))
    // `true` means the browser accepted it for delivery — not that it arrived.
    if (final && navigator.sendBeacon('/cells', new Blob([body], { type: 'application/json' }))) {
      return
    }
    return fetch('/cells', { method: 'POST', body, keepalive: final })
  },
})
```

### The five things that bite, and bite silently

- **64 KiB, for the whole page.** `fetch(…, { keepalive: true })` is capped at 64 KiB across *all*
  in-flight keepalive requests from the page. Over that, the request is **rejected** — not queued,
  not truncated. `navigator.sendBeacon` shares the same budget and returns `false` instead.
- **Batch at unload.** A per-key writer firing 200 keepalive requests as the page dies will lose
  most of them to that budget. One batched request carrying every due key is the shape that fits, so
  `flush` (the batch writer) is the better unload path — and it is why the batch writer gets the
  same `final` flag.
- **There are no retries after `final`.** The page is gone; there is no backoff left to run and no
  clock to run it on. `final: true` means *this is the only chance*. A writer that normally throws
  and lets the retry curve sort it out should not do that here — set `keepalive`, keep the body
  small, and send.
- **`final` is `true` for a backgrounded tab too.** No browser signal separates "hidden for a second"
  from "gone" (iOS Safari fires `pagehide` for both), so this library assumes the worse of the two.
  If your payloads can approach 64 KiB, gate on size rather than on `final` alone —
  `keepalive: final && body.length < 60_000` — because a rejected keepalive request loses the write
  that a plain one would have delivered.
- **It is still best-effort.** The browser may freeze the page before the request leaves the socket,
  and `keepalive` does not make delivery observable — nothing tells you whether it landed. `pending`
  is exposed so an app that must not lose the write can warn the user *before* they leave.

### Your own unload signal

`flush('unload')` says the same thing by hand. That is the escape hatch for a signal this library
refuses to listen to on your behalf — a `beforeunload` handler you insist on, a router leave guard,
an Electron close hook:

```ts
router.beforeEach(() => wb.flush('unload'))
```

## Preconditions — read these, they are not assumptions

- **Keys must be independent.** Writes go out in parallel, in no particular order, last-write-wins
  per key. If key `b` is only valid once key `a` has landed, this is the wrong tool.
- **Nothing here observes your object.** Call `sync()` after you mutate it, or use `set()`.
- **`equals` defaults to `Object.is`, so an object value mutated *in place* is not an edit.**
  Replace the object (`cells.A1 = { ...cells.A1, text }`), pass your own `equals`, or call
  `wb.set('A1', value)` — which always queues.
- **What the record starts with is seeded, not queued.** Whatever it was constructed with is assumed
  to have come from the server; only movement after that counts as an edit.
- **A key deleted from the record keeps its queued write.** Losing it silently is exactly what this
  library refuses to do. Call `discard(key)` if you mean it.
- **`discard(key)` cannot recall a request that has already left.** It drops the queued write and
  ignores the response, but the key stays reserved until that request answers, so a write queued in
  the meantime can never overtake it. Expect a key to sit in `pending` — and *not* in `inFlight` —
  for as long as the abandoned request takes.
- **The flush on the way out is best-effort.** Both signals are taken (`visibilitychange → hidden`
  and `pagehide`) rather than `beforeunload`, which mobile browsers routinely skip — but the page
  can still be frozen before the request leaves, and only `keepalive` makes a request outlive it.
  `pending` is exposed so your app can *warn* instead of failing silently.
- **`dispose()` is not optional in a long-lived process.** Nothing else stops the clock.

## What it will not do

Each of these is a step towards RxDB / Replicache / TanStack DB, where a single small package loses
on day one:

- **No persistence / IndexedDB.** Hook `pending` yourself — its identity is stable, so a subscriber
  fires when the set of unsaved keys actually moves, not on every retry of an outage.
- **No offline detection.** Offline is not a special case, it is a failing flush — the retry
  behaviour already covers it.
- **No conflict resolution or merge.** That needs a CRDT.
- **No reading.** It is write-only; nothing here fetches, caches or invalidates.
- **No ordered operation log and no cross-key transactions.**
- **No HTTP client, transport or `sendBeacon`.** You pass a function; what it does is your business.
  What the library *does* do is tell that function when the page is going away, so it can set
  `keepalive` — see [surviving a page refresh](#surviving-a-page-refresh--keepalive).
- **No schema and no collections.**

## Types

Everything is exported by name — nothing to recreate:

```ts
import type {
  WriteBehind,
  WriteBehindAttempt,
  WriteBehindBaseOptions,
  WriteBehindBatchOutcome,
  WriteBehindBatchWriter,
  WriteBehindFailure,
  WriteBehindKey,
  WriteBehindOptions,
  WriteBehindReason,
  WriteBehindRetryOptions,
  WriteBehindSource,
  WriteBehindWriter,
} from '@ozjsey/write-behind'
```

`T` is inferred from the record, so `createWriteBehind<number>({}, write)` gives you a `write` whose
value is a `number`.

## Development

```bash
npm test               # vitest: the state machine, the clock, the adapters, the diff, the engine
                       # (jsdom, plus a node project with no DOM at all)
npm run typecheck      # tsc over source and tests
npm run build          # tsup → dist/*.min.js + .cjs + .d.ts
npm run check:dist     # drive the BUILT artifact on real timers — dist goes stale silently
```

`ARCHITECTURE.md` has the module map, the invariant the split protects, and the three pieces of
per-key state that are deliberately kept apart. `CHANGELOG.md` is the version history.

## License

MIT © Ozgur Seyidoglu
