/**
 * Build entry point — re-exports the public surface from `src/`.
 *
 * The split keeps each concern in a single-purpose module (types / outbox /
 * scheduler / flush / shadow / snapshot / visibility / the engine) without
 * changing the bundle: tsup follows this entry and emits the same minified
 * files. See ARCHITECTURE.md for the module map and the invariant it protects.
 */
export { createWriteBehind } from './src'
export type {
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
} from './src'
