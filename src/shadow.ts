/**
 * The shadow map: the last value this engine *saw* per key.
 *
 * It answers exactly one question — "did this key move?" — and it is never the
 * value that gets sent. That comes out of the outbox at send time, which is
 * what makes a retry carry what the user has typed since the failure rather
 * than the value that failed.
 *
 * **The rule this module exists to hold: what the record starts with is seeded,
 * not queued.** A write-behind cache that fires a request for every key it was
 * handed on the first tick would echo the whole server payload straight back at
 * the server. So the constructor records the initial contents silently, and
 * only movement *after* that counts as an edit.
 */
import type { WriteBehindKey } from './types'

export interface ShadowConfig<T> {
  /** Read the current record. Called on every look — the object may be replaced. */
  read: () => Record<WriteBehindKey, T>
  /** Keys outside this filter are invisible here (the `keys` option). */
  tracked: (key: WriteBehindKey) => boolean
  /** Change detection for a value (the `equals` option). */
  equals: (a: T, b: T) => boolean
}

export interface Shadow<T> {
  /**
   * Every tracked key whose value has moved since the last look — and they are
   * recorded as seen on the way out, so an immediate second call reports
   * nothing.
   */
  changes: () => [WriteBehindKey, T][]
  /**
   * Record a value as seen without reporting it. `set()` writes the value into
   * the record and queues it itself; without this the next look would see the
   * same edit again and queue it twice.
   */
  record: (key: WriteBehindKey, value: T) => void
}

export function createShadow<T>({ read, tracked, equals }: ShadowConfig<T>): Shadow<T> {
  // Boxed so `T` may legitimately be `undefined` without `has`/`get`
  // disagreeing about whether a key has been seen.
  const seen = new Map<WriteBehindKey, { value: T }>()
  const record = (key: WriteBehindKey, value: T): void => {
    seen.set(key, { value })
  }

  for (const [key, value] of Object.entries(read())) {
    if (tracked(key)) record(key, value)
  }

  return {
    record,
    changes: () => {
      const current = read()
      const moved: [WriteBehindKey, T][] = []
      for (const [key, value] of Object.entries(current)) {
        if (!tracked(key)) continue
        const previous = seen.get(key)
        if (previous && equals(previous.value, value)) continue
        record(key, value)
        moved.push([key, value])
      }
      // A key deleted from the record stops being watched — but its queued
      // write survives in the outbox, because losing it silently is the one
      // outcome this library refuses. Forgetting it here is what makes putting
      // the same key back later count as an edit again.
      for (const key of seen.keys()) {
        if (!(key in current)) seen.delete(key)
      }
      return moved
    },
  }
}
