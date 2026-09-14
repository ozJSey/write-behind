# Architecture

`writeBehind.ts` is the build entry; it re-exports `src/index.ts`. Each module has one purpose;
dependencies point strictly downward — no cycles.

```
writeBehind.ts                 entry — re-exports src/index
└── src/
    ├── index.ts               public surface: createWriteBehind + the types
    ├── createWriteBehind.ts   the engine — wires the six below together, owns the one clock
    ├── shadow.ts              the last value SEEN per key — the diff, and nothing else
    ├── snapshot.ts            the outbox published as identity-stable values
    ├── visibility.ts          the one browser API here: visibilitychange + pagehide, de-duped
    ├── flush.ts               THE request site — per-key and batched writer adapters
    ├── scheduler.ts           the clock — flush interval, deadline wake-ups, the backoff curve
    ├── outbox.ts              THE state machine — keys, versions, dirtiness, flights, deadlines
    └── types.ts               public types (leaf: imports nothing at all)
```

Zero runtime dependencies, no peer dependencies, and nothing framework-shaped. `@ozjsey/vue-write-behind`
is a ~40-line adapter over this package; see its `ARCHITECTURE.md` for what a framework layer has
to add and, more usefully, what it does **not** get to re-decide.

## The invariant

**Nothing outside `outbox.ts` may clear a dirty key.**

Every other module can only *ask*. `flush.ts` reports an outcome (`settle` / `fail`) and the outbox
decides what that means; `snapshot.ts` reads and publishes; `scheduler.ts` does not know keys exist.
There is exactly one place where `entries.delete(key)` happens, and it is guarded by the version
check.

That guard is the whole product:

```ts
if (entry.version === sentVersion) entries.delete(key)   // nothing was typed while it was out
else { /* keep it dirty; send the newer value next tick */ }
```

A boolean dirty flag cannot express this. The response would clear a flag a newer edit had set, and
that edit would be gone — silently, with the correct-looking value still on screen. Every naive
write-behind implementation ships this bug, and it is invisible until a request is slow.

Two more properties fall out of keeping the decision in one place, and a third has to be built:

- **The value is read out of the map at send time** (`take()`), never captured when the edit
  happened. A retry therefore carries what the user has typed *since* the failure, not the value
  that failed. (`useMutation`-style retries re-send captured variables and can mark a cell saved
  with a stale value — this is the structural difference.) `shadow.ts` keeps a separate map of the
  last value it *saw* per key, but that only decides whether an edit happened; it is never the value
  that is sent.
- **A key already in flight is skipped**, even when it is dirty, so two requests for one cell can
  never race and land out of order. This one does *not* fall out of the version guard, and pretending
  it did is what shipped the 0.1.0 data-loss bug in the Vue package: `discard(key)` deleted the
  entry, the entry was the only record that a request was in the air, and the next edit opened a
  second concurrent request. It is now enforced by a second map — see below.
- **Failure never clears anything.** The only operation in the library that loses a write is
  `discard(key)`, and a consumer has to call it.

## The page going away

Two events, one flush. `visibilitychange → hidden` is backgrounding; `pagehide` is a refresh, a
same-tab navigation or a tab close — and on iOS Safari, a swipe-away that never fires
`visibilitychange` at all. Listening for only the first is why a swipe-away used to flush *nothing*.
`beforeunload` stays rejected: mobile browsers routinely discard a page without ever firing it, and
registering one costs the back/forward cache.

Desktop fires both for a single teardown, so `visibility.ts` latches on the way out and unlatches on
`pageshow` / `visibilitychange → visible`. The unit of de-duplication is **one departure**, not one
event and not one page — a backgrounded tab that comes back still flushes again the next time it
leaves.

That flush is a forced dispatch (`take(now, force)`), which is what makes it carry the character
typed 200 ms earlier: it ignores the debounce clock, the retry backoff and `retry: false`'s parked
state. The one rule it still obeys is the flight reservation, because a request cannot be recalled.

What the library **cannot** do is make the request outlive the page — that is the writer's, and the
writer is the consumer's function by design. So the flush says so instead: every writer call carries
a `WriteBehindAttempt` whose `final` is true exactly when the page is going away, and `keepalive:
final` is the whole recipe. `flush.ts` builds that object; nothing else in the engine knows the
reason exists.

## Three facts, three homes

Inside `outbox.ts`, a key's state is deliberately *not* one record. The 0.1.0 bug was a single
mutable `Entry` owning several independent facts, where every operation felt entitled to overwrite
all of them at once.

| Fact | Where it lives | Who may write it |
|---|---|---|
| what is queued for this key | `entries: Map<key, Entry>` | `set`, `settle`, `discard` |
| what is on the wire for it | `flights: Map<key, Flight>` | `take` (adds), `settle`/`fail` (remove), `discard` (disowns) |
| when it may next go | `entry.readyAt` (your `debounce`) and `entry.backoffUntil` (our retry curve), separately | `set` writes the first; `fail`/`settle`/`clearBackoff` write the second |

Two consequences, both of them bugs before 0.1.1 of the Vue package:

- **`discard()` cannot forget a request.** It deletes the entry and marks the flight *disowned* —
  the outcome is ignored, but the key stays reserved until it answers, so nothing can race it. A
  request that has left cannot be recalled, and the library refuses to pretend otherwise.
- **A response cannot cancel your debounce.** `settle` and `fail` write `backoffUntil`; only an edit
  writes `readyAt`. When both are set the key waits for the later one.

A `Flight` also carries the version it was sent with, which is what makes a response identify
itself: a reply whose version is not the one currently on the wire for that key is ignored outright.

## The seam: `sync()`

This package cannot observe a plain object. Nothing here is a proxy, a getter or an observer, and
that is deliberate — it is what makes the engine the same 5 KB in Node, in a worker and behind any
framework. So *something* has to say "look again", and that something is `sync()`.

`shadow.ts` answers the one question `sync()` asks: **did this key move since we last looked?** It
holds the last value seen per key, seeded from the record's initial contents and never reported —
whatever the record starts with came from the server, and echoing it straight back would be the
first request this library ever made. `set(key, value)` writes through to the record, records the
value as seen, and queues unconditionally; it is the escape hatch for a change `equals` cannot see
(an object mutated in place) and for keys `keys` filters out.

A framework adapter's entire job is wiring `sync()` to that framework's change signal. In Vue that
is `watch(source, sync, { deep: true })` — one line, and the reason `@ozjsey/vue-write-behind`
contains no state machine of its own.

## Publishing state without churning it

`outbox.pendingKeys()` builds a fresh array on every call, so a subscriber that re-read it on every
transition could never tell "the same two keys are still pending" from "a different two are". That
is not a micro-optimisation: an outage retries a key every few seconds for minutes, and a UI that
re-rendered on each of those would be re-rendering on nothing.

`snapshot.ts` therefore rebuilds each view only when its contents actually change, which makes
`next !== previous` a complete change check. `subscribe(fn)` fires after every transition, with the
snapshots already refreshed, and hands the listener nothing — it reads the getters and compares
identities. The Vue adapter mirrors all four into one `shallowReactive` on every notification and
relies on exactly this: assigning an unchanged array triggers nothing.

## Why the split is shaped this way

`outbox.ts` has no timers and no I/O — every clock reading arrives as an argument, including the
one `failures(now)` needs to publish a `retryAt` that is never in the past. That is what makes the
correctness core testable as pure data (`outbox.test.ts`, no fake timers) and mutation-testable in
seconds. The diff, the clock and the transport are each thin enough to read in one sitting once
that core is trusted.

`createWriteBehind.ts` owns the library's single `Date.now()` call site and hands the reading down;
it is the only module that reads a clock rather than being given one, and `scheduler.ts` is the only
one that owns timers (the interval, plus a one-shot wake-up for a deadline that falls between two
ticks — without which a `retry.initialDelay` shorter than `interval` would be rounded away).

**The clock runs wherever `setInterval` does — the browser and Node alike.** There is no `isServer()`
check here, and that is a deliberate departure from the Vue package it was extracted from: a Node
script batching writes to a database wants its interval, and "there is no `document`" does not mean
"do not run". What makes a server *render* different is that the render has to finish and its outbox
is discarded afterwards, which only a framework layer knows. That layer says so with
`autoFlush: false`, which is the one option a framework adapter is expected to set for you.

The bundle is unchanged by the split: tsup follows the single entry and tree-shakes. Verify with
`npm run build && npm pack --dry-run`, and `npm run check:dist` to prove the built artifact still
behaves (this repo has shipped a stale `dist/` three times).

Copy-paste consumers: every file under `src/` plus the entry is self-contained TypeScript with no
dependency of any kind — take the folder as-is, or lift `outbox.ts` on its own if all you want is
the state machine. The modules import each other without file extensions (`./outbox`), which is what
`moduleResolution: bundler` (this repo's `tsconfig.json`, and Vite/webpack/tsup projects) expects;
under `NodeNext` or plain Node ESM add the `.js` suffix to those specifiers.
