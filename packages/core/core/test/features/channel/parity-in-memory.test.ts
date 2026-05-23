/**
 * Parity suite - InMemory leg.
 *
 * Runs the shared channel-backend parity spec against MemoryChannelBackend.
 *
 * MemoryChannelBackend is a no-op transport (its source comments spell this
 * out: same-process subscribers are served by the higher-level Channel
 * class, NOT the backend). So at the BACKEND level there is no delivery
 * to assert: subscribe is a no-op disposable, publish is a no-op.
 *
 * That means only the structural-contract tests apply to memory:
 *   - subscribe returns a Disposable; dispose is idempotent
 *   - publish without subscribers does not throw
 *   - close() resolves; double close is idempotent
 *
 * Delivery and cross-instance tests are gated off and skip on memory.
 */

import { describe, it } from 'node:test';
import { MemoryChannelBackend } from '../../../src/features/channel/backend.js';
import type { ChannelBackend } from '../../../src/features/channel/backend.js';
import {
  registerChannelParityTests,
  type ChannelParityHarness,
} from './parity-spec.js';

describe('ChannelBackend parity - InMemory', () => {
  const harness: ChannelParityHarness = {
    async make() {
      // The defineService factory takes (deps, ctx); memory backend ignores
      // both. This matches the pattern used by the existing
      // channels-backend.test.ts in src/features/channel/test.
      const backend = MemoryChannelBackend.factory({} as any, undefined as any) as ChannelBackend;
      const keyPrefix = `mem:${Math.random().toString(36).slice(2, 8)}:`;
      return {
        backend,
        keyPrefix,
        async destroy() {
          await backend.close();
        },
      };
    },
    // No second-instance simulator: memory backend is local-only.
  };

  registerChannelParityTests(it, harness, {
    supportsDelivery: false,
    supportsCrossInstance: false,
    subscribeSettleMs: 0,
    nonDeliveryWaitMs: 5,
  });
});
