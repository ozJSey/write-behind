/**
 * The outbox, published as values a subscriber can diff by identity.
 *
 * `outbox.pendingKeys()` builds a fresh array every call, so a consumer that
 * re-read it on every transition could never tell "two keys are still pending"
 * from "a different two keys are pending now". This module rebuilds each view
 * only when its contents actually change, which makes `next !== previous` a
 * complete change check — cheap enough that a UI layer can mirror all four on
 * every transition and still not re-render through a retry storm.
 */
import type { Outbox } from './outbox'
import type { WriteBehindFailure, WriteBehindKey } from './types'

export interface Snapshot {
  readonly pending: readonly WriteBehindKey[]
  readonly inFlight: readonly WriteBehindKey[]
  readonly failed: readonly WriteBehindFailure[]
  readonly isSyncing: boolean
  /**
   * Re-read the outbox. `now` clamps every `retryAt` out of the past, so a
   * failure's countdown is relative to the moment the transition happened.
   */
  refresh: (now: number) => void
}

const sameKeys = (a: readonly WriteBehindKey[], b: readonly WriteBehindKey[]): boolean =>
  a.length === b.length && a.every((key, index) => key === b[index])

const sameFailures = (
  a: readonly WriteBehindFailure[],
  b: readonly WriteBehindFailure[],
): boolean =>
  a.length === b.length &&
  a.every((failure, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      failure.key === other.key &&
      failure.error === other.error &&
      failure.attempts === other.attempts &&
      failure.retryAt === other.retryAt
    )
  })

export function createSnapshot<T>(outbox: Outbox<T>): Snapshot {
  let pending: readonly WriteBehindKey[] = []
  let inFlight: readonly WriteBehindKey[] = []
  let failed: readonly WriteBehindFailure[] = []

  return {
    get pending() {
      return pending
    },
    get inFlight() {
      return inFlight
    },
    get failed() {
      return failed
    },
    get isSyncing() {
      return inFlight.length > 0
    },
    refresh: (now) => {
      const nextPending = outbox.pendingKeys()
      const nextInFlight = outbox.inFlightKeys()
      const nextFailed = outbox.failures(now)
      if (!sameKeys(pending, nextPending)) pending = nextPending
      if (!sameKeys(inFlight, nextInFlight)) inFlight = nextInFlight
      if (!sameFailures(failed, nextFailed)) failed = nextFailed
    },
  }
}
