/**
 * Public surface. The outbox, scheduler, flush adapters, shadow map, snapshots
 * and visibility hook stay internal — a consumer needs one function and the
 * types around it.
 */
export { createWriteBehind } from './createWriteBehind'
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
} from './types'
