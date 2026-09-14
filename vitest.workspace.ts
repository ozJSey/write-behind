import { defineWorkspace } from 'vitest/config'

/**
 * Two projects, because "runs without a DOM" is a claim this package makes:
 *
 *   - `jsdom` — the state machine, the clock, the writer adapters and the
 *     engine. jsdom is here for one reason only: `flushOnHidden` listens to
 *     `document`. Everything else would pass in either environment.
 *
 *   - `node` — no `window`, no `document`. Proves the package imports with no
 *     top-level DOM access, that the tab-hidden hook degrades to a no-op
 *     instead of throwing, and that the clock still runs, because Node is a
 *     first-class target here and not a degraded browser.
 */
export default defineWorkspace([
  {
    test: {
      name: 'jsdom',
      environment: 'jsdom',
      include: [
        'outbox.test.ts',
        'scheduler.test.ts',
        'flush.test.ts',
        'shadow.test.ts',
        'snapshot.test.ts',
        'createWriteBehind.test.ts',
      ],
    },
  },
  {
    test: {
      name: 'node',
      environment: 'node',
      include: ['writeBehind.node.test.ts'],
    },
  },
])
