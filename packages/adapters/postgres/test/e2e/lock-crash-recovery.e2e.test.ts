/**
 * Postgres lock - crash / connection-loss recovery.
 *
 * Pg advisory locks are SESSION-scoped. When the holder's connection dies
 * (crash, network partition, `pg_terminate_backend`), the lock MUST become
 * acquirable by someone else - otherwise a dead node freezes a key forever.
 *
 * This is the distributed-lock property that motivates using pg over a local
 * Map. If the session-death path doesn't work, the whole story fails.
 *
 * Strategy of these tests:
 * - Session A acquires a lock.
 * - We KILL session A's backend via pg_terminate_backend from a separate
 *   admin session.
 * - Session B then acquires the same lock; assert this happens within a
 *   bounded time (no hang).
 *
 * Table-lock strategy recovers via TTL instead of session death, but the
 * test shape is similar: holder dies with an expired lock -> someone else
 * acquires.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createPostgresLockProvider } from '../../src/index.js';
import { createRawPostgresClient } from '../../src/client/client.js';
import type { AbstractPostgresClient } from '../../src/index.js';
import { requirePostgres, CONNECTION_STRING } from '../__mocks__/test-setup.js';
import type { LockOptions } from '@justscale/core';

function opts(overrides: Partial<LockOptions> = {}): Required<LockOptions> {
  return {
    ttl: 30_000,
    timeout: 0,
    key: '',
    heartbeat: false,
    heartbeatInterval: 10_000,
    ...overrides,
  };
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeClient(): { client: AbstractPostgresClient, close: () => Promise<void> } {
  const client = createRawPostgresClient({ connectionString: CONNECTION_STRING, max: 4 });
  return {
    client,
    async close() {
      try { await client.close(); } catch { /* already closed */ }
    },
  };
}

describe('PostgreSQL Lock - crash recovery', { timeout: 60_000 }, async () => {
  if (!(await requirePostgres())) return;

  let adminClient: AbstractPostgresClient;
  let adminClose: () => Promise<void>;

  before(async () => {
    const a = makeClient();
    adminClient = a.client;
    adminClose = a.close;
  });

  after(async () => {
    await adminClose();
  });

  beforeEach(async () => {
    await adminClient.sql`SELECT pg_advisory_unlock_all()`;
  });

  it('INVARIANT: killing the holder session via pg_terminate_backend frees the advisory lock', async () => {
    // Holder is a raw postgres client with a UNIQUE application_name so
    // we can surgically pg_terminate_backend only its sessions, without
    // disturbing anyone else.
    const holderAppName = `lock-crash-test-${randomUUID().slice(0, 8)}`;
    const holderSql = postgres(CONNECTION_STRING, {
      max: 1,
      connection: { application_name: holderAppName },
    });
    // Wrap it in a minimal AbstractPostgresClient-shaped object so the
    // provider sees the expected `.pool` API.
    const holderClient = {
      get sql() { return holderSql as unknown as import('postgres').Sql<{}>; },
      get pool() { return holderSql as unknown as import('postgres').Sql<{}>; },
      get inTransaction() { return false; },
      get transactionDepth() { return 0; },
      async transaction<T>(fn: () => Promise<T>) { return fn(); },
      afterCommit() {},
      afterRollback() {},
      async close() { await holderSql.end({ timeout: 1 }); },
      getFromIdentityMap<T>(_t: string, _id: string): T | undefined { return undefined; },
      storeInIdentityMap() {},
      clearIdentityMap() {},
      removeFromIdentityMap() {},
    } as unknown as AbstractPostgresClient;

    const challenger = makeClient();
    const killer = postgres(CONNECTION_STRING, { max: 1 });
    const key = `crash:${randomUUID().slice(0, 8)}`;

    try {
      const holderProvider = createPostgresLockProvider(holderClient, { strategy: 'advisory' });
      const challengerProvider = createPostgresLockProvider(challenger.client, { strategy: 'advisory' });

      // 1. Holder grabs the lock.
      await holderProvider.acquire(key, opts({ ttl: 60_000 }), 'holder');

      // 2. Challenger starts acquire - must block.
      let acquired = false;
      const challengerPromise = challengerProvider
        .acquire(key, opts({ ttl: 60_000 }), 'challenger')
        .then(() => { acquired = true; })
        .catch(() => { /* ignore errors */ });

      await delay(150);
      assert.strictEqual(acquired, false, 'challenger must block while holder holds');

      // 3. Kill EVERY session belonging to the holder app. Pg releases
      //    advisory locks on session termination.
      await killer`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE application_name = ${holderAppName}
          AND pid <> pg_backend_pid()
      `;

      // 4. Challenger must acquire within 10s of the kill.
      const killAt = Date.now();
      await Promise.race([
        challengerPromise,
        delay(10_000).then(() => { throw new Error('challenger timed out after holder was killed'); }),
      ]);
      const elapsed = Date.now() - killAt;
      assert.ok(acquired, 'challenger must have acquired after holder died');
      assert.ok(elapsed < 10_000, `challenger took too long (${elapsed}ms)`);

      await challengerProvider.release(key, 'challenger');
      await challengerProvider.close();
    } finally {
      await challenger.close();
      // Holder sql is dead at the server side; ending it locally is fine.
      try { await holderSql.end({ timeout: 1 }); } catch { /* expected */ }
      await killer.end({ timeout: 1 });
    }
  });

  it('INVARIANT: table-lock strategy - an expired lock from a "crashed" instance is takeable', async () => {
    // For table locks, crash recovery is TTL-based. We don't need to kill
    // a connection: we just stamp an expired row for a phantom instance.
    const tableName = `test_crash_locks_${randomUUID().slice(0, 8).replace(/-/g, '_')}`;

    try {
      await adminClient.sql.unsafe(`
        CREATE TABLE ${tableName} (
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

      const key = `tbl-crash:${randomUUID().slice(0, 8)}`;

      // Plant a "crashed" holder: expired lock row.
      const expiredAt = new Date(Date.now() - 5_000).toISOString();
      await adminClient.sql.unsafe(`
        INSERT INTO ${tableName} (lock_key, instance_id, fencing_token, expires_at)
        VALUES ('${key}', 'crashed-instance', 1, '${expiredAt}')
      `);

      // Fresh provider / new instance should pick up the orphaned lock.
      const provider = createPostgresLockProvider(adminClient, {
        strategy: 'table',
        tableName,
      });

      const start = Date.now();
      const meta = await provider.acquire(key, opts({ ttl: 5_000 }), 'fresh-instance');
      const elapsed = Date.now() - start;

      assert.ok(meta, 'fresh instance must acquire orphaned lock');
      assert.ok(elapsed < 5_000, `takeover should be fast, took ${elapsed}ms`);
      assert.strictEqual(meta.lockedBy, 'fresh-instance');

      await provider.release(key, 'fresh-instance');
      await provider.close();
    } finally {
      await adminClient.sql.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
    }
  });

  it('INVARIANT: after provider.close() on the holder side, lock is released (graceful shutdown)', async () => {
    // Graceful version of the crash test: no kill, provider just closes.
    const a = makeClient();
    const b = makeClient();
    const key = `graceful:${randomUUID().slice(0, 8)}`;
    try {
      const providerA = createPostgresLockProvider(a.client, { strategy: 'advisory' });
      const providerB = createPostgresLockProvider(b.client, { strategy: 'advisory' });

      await providerA.acquire(key, opts(), 'A');
      await providerA.close();

      const start = Date.now();
      const meta = await providerB.acquire(key, opts(), 'B');
      const elapsed = Date.now() - start;

      assert.ok(meta, 'B must acquire after A closes gracefully');
      assert.ok(elapsed < 2_000, `acquire after close should be fast, took ${elapsed}ms`);

      await providerB.release(key, 'B');
      await providerB.close();
    } finally {
      await a.close();
      await b.close();
    }
  });
});
