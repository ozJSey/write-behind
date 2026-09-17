# @ozjsey/write-behind

Queue writes, coalesce them per key, send them on a clock, retry with backoff — in plain TypeScript
with **zero dependencies**, no peer dependencies and no framework. It runs in the browser, in Node,
in a worker.

[![npm version](https://img.shields.io/npm/v/@ozjsey/write-behind.svg)](https://www.npmjs.com/package/@ozjsey/write-behind)

> **[See it live](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind)** — the
> playground cards drive this engine through its Vue adapter, against a fake server you can break
> from the card.

## The problem

A key is edited while its own save is in flight. This is the case a boolean dirty flag gets wrong:

```text
t=0    user types "hello"      → queued, dirty
t=50   request leaves with "hello"
t=60   user types "hello!"     → still dirty, newer value
t=900  the t=50 response lands → "saved!" → dirty flag cleared
```

`"hello!"` is now gone. It is on screen, it looks correct, nothing errored, and the server holds
`"hello"` forever. **A slow response cannot clear a newer edit** is the bug every naive write-behind
ships, it is invisible until a request is slow, and it is the reason this package exists.

## The solution

Each key carries a **monotonic version**, a request records the version it was sent at, and a
success clears the key **only if** the version has not moved. Local state stays authoritative and
the network is a background chore. Edit a key ten times and one request goes out carrying the tenth
value. The server's reply is *discarded on purpose* — it can never overwrite the value the user is
still typing. A failed save rolls nothing back; the key stays dirty and goes out again next tick,
carrying whatever has been typed since.

```ts
import { createWriteBehind } from '@ozjsey/write-behind'

const cells: Record<string, string> = { A1: 'foo' }

const wb = createWriteBehind(cells, (value, key) => api.put(`/cell/${key}`, value))

cells.A1 = 'bar'
wb.sync()             // "I changed the record" — diff it and queue what moved
wb.set('A1', 'bar')   // or do both in one call, skipping the diff
```

**`sync()` is the one thing you have to do.** A plain object cannot announce that it changed —
there is no proxy here and no observer, which is what keeps this package framework-free — so after
you mutate the record, say so. It is idempotent and cheap when nothing has moved: a walk of the
record, not a request.

It is a **state outbox, not an operation log**: keys are independent and last-write-wins. If key
`b` is only valid once key `a` has landed, this is the wrong tool.

Using Vue? [`@ozjsey/vue-write-behind`](https://www.npmjs.com/package/@ozjsey/vue-write-behind) is
this engine with the `sync()` call wired to Vue's reactivity and the state mirrored into a reactive
store. Everything here still applies; you just never call `sync()` yourself.

## Install

```bash
npm install @ozjsey/write-behind
```

No dependencies and no peer dependencies, and nothing to register. The clock runs in Node exactly
as it does in a browser — Node is a target, not a degraded browser.

## Usage

### A save indicator

```ts
const wb = createWriteBehind(cells, (value, key) => api.put(`/cell/${key}`, value))

let last = wb.pending
wb.subscribe(() => {
  if (wb.pending === last) return   // a retry storm changed nothing
  last = wb.pending
  render({ unsaved: wb.pending.length, saving: wb.isSyncing, failing: wb.failed })
})
```

`pending`, `inFlight`, `failed` and `isSyncing` are **snapshot getters**, not live arrays: reading
one gives the value as of the last transition, and its identity does not change while its contents
do not. So a subscriber can skip a no-op with one `!==`.

### A batch endpoint

One call per tick, every due key in it:

```ts
createWriteBehind(cells, {
  flush: (entries) => api.patch('/cells', Object.fromEntries(entries)),
})
```

Throw or reject and the **whole batch** stays pending. Resolve with `{ failed: ['A1'] }` to fail
part of it — everything else in the batch is treated as written.

### Surviving a page refresh

```ts
createWriteBehind(cells, (value, key, { final }) =>
  fetch(`/cell/${key}`, {
    method: 'PUT',
    body: JSON.stringify(value),
    keepalive: final,        // the browser finishes this one after the page is gone
  }),
)
```

When the page goes away this library flushes on `visibilitychange → hidden` **and** `pagehide`,
de-duplicated into one — `beforeunload` is deliberately not used, because mobile browsers routinely
discard a page without ever firing it. That flush is **forced**: it ignores the debounce clock, the
retry backoff and `retry: false`, so it carries the character typed 200 ms before the tab closed.
What it cannot do is make the request outlive the page. Only `keepalive` does that, and the request
is yours. `flush('unload')` says the same thing by hand, for a router leave guard or an Electron
close hook.

## Everything else

The playground drives this engine through its Vue adapter, against a fake server you can break from
the card — every option, every state, in a real browser:
[**the cell does not jump**](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/no-jump) ·
[coalescing](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/coalescing) ·
[failure never rolls back](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/failure-and-retry) ·
[`retry: false` parks a key](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/retry-false) ·
[`pending` / `inFlight` / `failed`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/live-state) ·
[a batch endpoint](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/batch) ·
[`discard()`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/discard) ·
[`interval` vs `debounce`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/interval-and-debounce) ·
[`keys`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/keys-filter) ·
[`equals`, and why in-place mutation is not an edit](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/equals-and-set) ·
[`flush()`, and the flush when the page goes away](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/flush-and-tab-hide)

`ARCHITECTURE.md` has the module map, the invariant the split protects, and the three pieces of
per-key state that are deliberately kept apart. [`CHANGELOG.md`](./CHANGELOG.md) is the version
history.

## License

MIT © Ozgur Seyidoglu
