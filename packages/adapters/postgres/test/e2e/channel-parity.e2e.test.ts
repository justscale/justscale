/**
 * Parity suite - Postgres leg.
 *
 * Runs the same channel-backend spec as
 * test/features/channel/parity-in-memory.test.ts, but against
 * PostgresChannelBackend. Any invariant that passes for memory but fails
 * here is a parity gap.
 *
 * Each PostgresChannelBackend instance opens its own dedicated LISTEN
 * connection (postgres-pubsub uses max:1). For cross-instance tests we
 * spin up two backends against the same database - they share the wire
 * but each owns its socket, mirroring two app processes.
 *
 * A per-suite test database is used so concurrent suites cannot leak
 * NOTIFY events into each other's assertions.
 */

import { describe, it, before, after } from 'node:test';
import { PostgresChannelBackend } from '../../src/channel/channel-backend.js';
import {
  requirePostgres,
  createTestDatabase,
  type TestDatabase,
} from '../__mocks__/test-setup.js';
import {
  registerChannelParityTests,
  type ChannelParityHarness,
} from '../../../../core/core/test/features/channel/parity-spec.js';

describe('ChannelBackend parity - Postgres', { timeout: 60_000 }, async () => {
  if (!(await requirePostgres())) return;

  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase('channel_parity');
  });

  after(async () => {
    await db.drop();
  });

  const harness: ChannelParityHarness = {
    async make() {
      const backend = new PostgresChannelBackend({
        connectionString: db.connectionString,
      });
      const keyPrefix = `pg:${Math.random().toString(36).slice(2, 8)}:`;
      return {
        backend,
        keyPrefix,
        async destroy() {
          try { await backend.close(); } catch { /* */ }
        },
      };
    },
    async makeSecondInstance(_keyPrefix: string) {
      const backend = new PostgresChannelBackend({
        connectionString: db.connectionString,
      });
      return {
        backend,
        async destroy() {
          try { await backend.close(); } catch { /* */ }
        },
      };
    },
  };

  registerChannelParityTests(it, harness, {
    supportsDelivery: true,
    supportsCrossInstance: true,
    subscribeSettleMs: 250,
    nonDeliveryWaitMs: 250,
  });
});
