/**
 * Parity suite — InMemory leg.
 *
 * Runs the shared parity spec against createInMemoryLockProvider. The
 * SAME spec file is consumed by the Postgres parity test. Any divergence
 * between providers will show up here vs. there.
 *
 * No separate-process simulator: InMemory by definition is single-process,
 * so cross-process takeover tests skip.
 */

import { describe, it } from 'node:test';
import { createInMemoryLockProvider } from '../../../src/features/lock/memory.js';
import { registerParityTests } from './parity-spec.js';

describe('LockProvider parity — InMemory', () => {
  registerParityTests(it, {
    async make() {
      const provider = createInMemoryLockProvider();
      const keyPrefix = `im:${Math.random().toString(36).slice(2, 8)}:`;
      return {
        provider,
        keyPrefix,
        async destroy() {
          await provider.close();
        },
      };
    },
    // No separate-process simulator.
  });
});
