/**
 * Test-only helpers. Not part of the published surface (`files: ["dist"]`).
 */

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

/** A promise whose settlement the test controls — the fake network. */
export function deferred<T = void>(): Deferred<T> {
  let settleResolve: (value: T) => void = () => {}
  let settleReject: (reason?: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    settleResolve = res
    settleReject = rej
  })
  // Swallow the rejection so an intentionally-failing write never trips
  // Node's unhandled-rejection handler; every caller under test catches it too.
  promise.catch(() => {})
  return {
    promise,
    resolve: (value: T) => settleResolve(value),
    reject: (reason?: unknown) => settleReject(reason),
  }
}

/**
 * Drain the microtask queue. Deliberately timer-free so it behaves identically
 * under `vi.useFakeTimers()`; ten turns is plenty for the promise chains here.
 */
export async function microtasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}
