/**
 * Parity suite - Postgres leg.
 *
 * Runs the same spec as test/features/lock/parity-in-memory.test.ts, against
 * the Postgres lock provider. Any invariant that passes for InMemory but
 * fails here is a parity gap - pins it down as a concrete failing test.
 *
 * We run it against BOTH postgres strategies (advisory + table) to catch
 * divergence between those too.
 */

import { describe, it, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPostgresLockProvider } from '../../src/index.js';
import { createRawPostgresClient } from '../../src/client/client.js';
import { requirePostgres, CONNECTION_STRING } from '../__mocks__/test-setup.js';
import { registerParityTests } from '../../../../core/core/test/features/lock/parity-spec.js';

describe('LockProvider parity - Postgres (advisory)', { timeout: 60_000 }, async () => {
  if (!(await requirePostgres())) return;

  registerParityTests(it, {
    async make() {
      const client = createRawPostgresClient({ connectionString: CONNECTION_STRING, max: 4 });
      const provider = createPostgresLockProvider(client, { strategy: 'advisory' });
      const keyPrefix = `pa:${randomUUID().slice(0, 8)}:`;
      return {
        provider,
        keyPrefix,
        async destroy() {
          try { await provider.close(); } catch { /* */ }
          try { await client.close(); } catch { /* */ }
        },
      };
    },
    async makeSeparateProcess() {
      const client = createRawPostgresClient({ connectionString: CONNECTION_STRING, max: 4 });
      const provider = createPostgresLockProvider(client, { strategy: 'advisory' });
      return {
        provider,
        async destroy() {
          try { await provider.close(); } catch { /* */ }
          try { await client.close(); } catch { /* */ }
        },
      };
    },
  });
});

describe('LockProvider parity - Postgres (table)', { timeout: 60_000 }, async () => {
  if (!(await requirePostgres())) return;

  // Shared table set up once for the whole suite - each make() uses a
  // unique key prefix to stay isolated.
  const tableName = `parity_locks_${randomUUID().slice(0, 8).replace(/-/g, '_')}`;
  let adminClient: ReturnType<typeof createRawPostgresClient>;

  before(async () => {
    adminClient = createRawPostgresClient({ connectionString: CONNECTION_STRING, max: 2 });
    await adminClient.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        lock_key VARCHAR(512) PRIMARY KEY,
        instance_id VARCHAR(255) NOT NULL,
        fencing_token BIGINT NOT NULL DEFAULT 1,
        expires_at TIMESTAMPTZ NOT NULL,
        heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await adminClient.sql.unsafe(
      'CREATE SEQUENCE IF NOT EXISTS global_fencing_token START 1 INCREMENT 1 CACHE 100',
    );
  });

  after(async () => {
    try {
      await adminClient.sql.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
    } finally {
      await adminClient.close();
    }
  });

  registerParityTests(it, {
    async make() {
      const client = createRawPostgresClient({ connectionString: CONNECTION_STRING, max: 4 });
      const provider = createPostgresLockProvider(client, { strategy: 'table', tableName });
      const keyPrefix = `pt:${randomUUID().slice(0, 8)}:`;
      return {
        provider,
        keyPrefix,
        async destroy() {
          try { await provider.close(); } catch { /* */ }
          try { await client.close(); } catch { /* */ }
        },
      };
    },
    async makeSeparateProcess() {
      const client = createRawPostgresClient({ connectionString: CONNECTION_STRING, max: 4 });
      const provider = createPostgresLockProvider(client, { strategy: 'table', tableName });
      return {
        provider,
        async destroy() {
          try { await provider.close(); } catch { /* */ }
          try { await client.close(); } catch { /* */ }
        },
      };
    },
  });
});
