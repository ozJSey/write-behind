# Changelog

All notable changes to `@ozjsey/write-behind`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.2 — 2026-09-20

A ceiling on retries. Shipped as a patch on purpose: `@ozjsey/vue-write-behind` depends on
`^0.1.0`, and a caret pins the MINOR on a 0.x package — a 0.2.0 engine would never reach a single
Vue consumer.

### Added

- **`retry.maxRetries`, default `5`.** A failing key now gets five scheduled retries — 1s, 2, 4, 8,
  16 — and is then blocked. `Infinity` restores the previous behaviour by name.

### Fixed

- **A write that could never succeed retried every 30 seconds for the life of the page.** The
  curve was `min(initialDelay * factor ** (attempts - 1), maxDelay)` for every attempt, with no
  ceiling and no option that could add one, so it treated a permanent failure — a 400, a malformed
  payload, a worker module that throws at load because its context is incomplete — exactly like a
  flaky network. `retry: false` was the only stop, and it gives up after the *first* failure.

  Blocked is not discarded, and that distinction is the whole design: the value and its place in
  the outbox survive, and a fresh edit, an explicit `retry()` or a forced take all re-arm the key.
  Giving up on the *schedule* is not giving up on the write — losing a queued write silently
  remains the one outcome this library refuses.

  One existing test had to change rather than being made to pass: the default curve's assertion
  covered attempts 6, 7 and 20, which no longer get a delay. The cap test keeps its invariant by
  opting into `maxRetries: Infinity`, because it is testing that the delay never exceeds `maxDelay`
  — with the new default the curve would be blocked long before attempt 50 and the overflow it
  guards against would never be computed.

## 0.1.1 — 2026-09-18

Documentation only; no code change. The README is cut to a landing page — problem, solution,
install, a couple of usage examples — because the playground now carries the reference: every
option driven in a real browser rather than described in a table. Claims that could not be
verified against the source were deleted rather than carried across.

## [0.1.0] — 2026-09-14

First release. The engine was extracted from `@ozjsey/vue-write-behind` 0.1.1, which now consumes
it: one state machine, two packages, no fork. Everything below already existed and was already
tested — this entry records what moved, what changed on the way, and what is genuinely new.

### Added

- **`createWriteBehind(source, writerOrOptions)`** — the whole surface. `source` is a
  `Record<string, T>` or a getter for one; the writer is a per-key function or an options object
  carrying `write` (per key) or `flush` (batched).

- **`sync()`** — diff the record against what was last seen and queue what moved. This is the one
  member with no counterpart in the Vue package, where `watch(source, sync, { deep: true })` calls
  it for you. It is idempotent and cheap when nothing has moved: a walk of the record, not a
  request.

- **`subscribe(listener)`** — called after every outbox transition, with the published snapshots
  already refreshed. Returns the unsubscribe. `pending` / `inFlight` / `failed` / `isSyncing` are
  snapshot getters whose **identity is stable while their contents do not change**, so a listener
  can skip a no-op with one `!==` — which is what lets a UI layer mirror all four on every
  transition and still stay quiet through a retry storm.

- **The flush when the page goes away takes both signals** — `visibilitychange → hidden` *and*
  `pagehide`, de-duplicated so a browser firing both (the common desktop teardown) sends one request
  rather than two, and re-armed by `pageshow` / `visibilitychange → visible` so a backgrounded tab
  that comes back still flushes the next time it leaves.

  The Vue package listened only to `visibilitychange`, and its own comment named the reason
  `beforeunload` was rejected — *"Safari fires `pagehide` instead"* — without then listening for
  `pagehide`. Measured on that code: a `pagehide` with no `visibilitychange`, which is what an iOS
  Safari swipe-away and some same-tab navigations produce, flushed **nothing**. `beforeunload` stays
  rejected. Covered by `createWriteBehind.test.ts` → "flush when the page goes away" (either event
  alone, both together, and the re-arm), and driven through the built artifact by
  `npm run check:dist` pass 5.

- **`WriteBehindAttempt` — the writer is told why it was called.** A third argument to `write` and a
  second to `flush`, both additive: `{ reason: 'scheduled' | 'manual' | 'unload', final: boolean,
  attempt: number }`. Every existing two-argument writer keeps compiling and keeps working.

  It exists because this library owns no transport — the writer is your function, by design — so it
  cannot set `keepalive` for you. What it can do is say when that matters:

  ```ts
  createWriteBehind(cells, (value, key, { final }) =>
    fetch(`/cell/${key}`, { method: 'PUT', body: JSON.stringify(value), keepalive: final }),
  )
  ```

  `attempt` is the try number for that key (`1`, then `2` after a failure); a batch writer gets the
  highest number in its batch. The READMEs carry the constraints that bite silently: the 64 KiB
  budget shared by every in-flight keepalive request in the page, `sendBeacon` being POST-only and
  sharing it, why the batch writer is the better unload path, and that `final` means there is no
  retry after this one.

- **`flush('unload')`** — say "the page is going away" by hand. The escape hatch for the signal this
  library refuses to listen to on your behalf: a `beforeunload` handler you insist on, a router
  leave guard, an Electron close hook.

- **`dispose()`** — stop the clock and drop the page-hidden listeners. Idempotent, and it
  loses nothing: queued writes stay queued and `flush()` still sends them.

  It is also **final**, which fixes a latent leak inherited from the Vue package. There,
  `scheduler.dispose()` ran on scope disposal but nothing stopped a *later* outbox transition from
  re-arming the clock — so disposing a component while a save was in flight, with a newer edit
  queued behind it, let the response start a brand new interval on a dead composable, which then
  wrote forever. Disposal is now a one-way flag the scheduler is re-armed behind. Covered by
  `createWriteBehind.test.ts` → "cannot be undone by a response landing after it".

- **`autoFlush`** (default `true`) — run the flush clock, or do not. Edits still queue under
  `false`, `pending` still reports them and `flush()` still sends them; only the automatic cadence
  is off. It exists because **this package does not check for a DOM before starting its timer**,
  unlike the Vue package it came from: Node is a first-class target here, and a script batching
  writes to a database wants its interval. What makes a server *render* different is that the
  render has to finish and its outbox is discarded afterwards — something only a framework layer
  knows, so that layer says so with `autoFlush: false`.

### Changed — relative to the same code inside `@ozjsey/vue-write-behind` 0.1.1

- **`WriteBehindSource<T>` drops its `Ref` arm and gains a getter arm**
  (`Record<string, T> | (() => Record<string, T>)`). The `Ref` arm belongs to the Vue package and
  stayed there.
- **The batch writer's synthetic error message** is now
  `write-behind: batch flush reported "<key>" as failed`, previously prefixed `vue-write-behind:`.
  Nothing has ever matched on it; it is listed because it is the only user-visible string that
  moved.
- **`isServer()` is gone.** The page-hidden listener checks for `document` and `window` on its own
  and degrades to a no-op without them — that is a feature detection, not an environment guess. See
  `autoFlush` above for the part that was a guess. It now needs both globals because
  `pagehide`/`pageshow` are window events; a fake DOM that stubs only `document` will no longer
  receive the unload flush (the Vue package's `dist-check.mjs` was exactly such a fake, and now
  dispatches for real).

### Unchanged — moved verbatim, with their suites

`outbox.ts` (the state machine, including the version guard, the separate flight map and the two
independent deadlines) and `scheduler.ts` (the interval, the deadline wake-up and the backoff curve)
contained no framework code and moved without edits, along with `outbox.test.ts` (50 declarations)
and `scheduler.test.ts` (15). The behaviour those suites pin — including every fix in
`@ozjsey/vue-write-behind` 0.1.1 — is unchanged.

`flush.ts` moved the same way and then gained the `WriteBehindAttempt` argument described above;
`outbox.ts` gained one field on the entry it hands out (`attempt`, read off the failure count it
already kept). Neither changes a transition.

### Tested

173 declarations across seven suites. `outbox.test.ts` and `scheduler.test.ts` came with their
modules unchanged; `flush.test.ts` came with `flush.ts` and grew seven cases for the attempt
argument. The other four are new, because the logic between the record and the outbox previously had
coverage only through the Vue composable:

| Suite | What it pins |
|---|---|
| `shadow.test.ts` | seeding (initial contents are seeded, never queued), `equals`, the `keys` filter in both forms, deletion and re-addition |
| `snapshot.test.ts` | identity moves only when contents move; `retryAt` clamped out of the past |
| `createWriteBehind.test.ts` | the engine end to end — the clocks, `set`/`sync`/`flush`/`retry`/`discard`, `subscribe`, `autoFlush`, disposal, the batch writer, the flush when the page goes away, and the attempt handed to the writer |
| `writeBehind.node.test.ts` | imports and runs the full cycle with no `window` and no `document` |

`npm run check:dist` drives the built ESM **and** CommonJS artifacts on real timers, including the
0.1.0 data-loss regression and — against a fake DOM that dispatches for real — the `pagehide` flush
and the `final` flag, because a minifier renaming a property on the attempt object would break the
`keepalive` recipe silently.

[0.1.0]: https://github.com/ozJSey/write-behind/releases/tag/v0.1.0
