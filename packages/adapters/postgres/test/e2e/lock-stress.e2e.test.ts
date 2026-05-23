/**
 * Postgres lock - stress tests.
 *
 * Pg locks talk over the wire, so "stress" here is more modest than the
 * in-memory tests (10s of operations, not 1000s). These cases pin down:
 *
 * - Rapid acquire/release cycles against a real pool don't leak connections
 *   (which would surface as the advisory provider's `pool.reserve()` hanging
 *   after N cycles).
 * - Parallel workers on a small set of keys finish without deadlock.
 * - The reserved-connection pool is returned correctly on both the success
 *   and the release path.
 *
 * All tests use unique key prefixes to avoid stepping on other suites.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresLockProvider } from '../../src/index.js';
import { createRawPostgresClient } from '../../src/client/client.js';
import type { AbstractPostgresClient } from '../../src/index.js';
import { requirePostgres, CONNECTION_STRING } from '../__mocks__/test-setup.js';
import type { LockOptions } from '@justscale/core';

function opts(overrides: Partial<LockOptions> = {}): Required<LockOptions> {
  return {
    ttl: 60_000,
    timeout: 0,
    key: '',
    heartbeat: false,
    heartbeatInterval: 20_000,
    ...overrides,
  };
}

describe('PostgreSQL Lock - stress', { timeout: 120_000 }, async () => {
  if (!(await requirePostgres())) return;

  let client: AbstractPostgresClient;

  before(async () => {
    // A larger pool so the provider's reserved-connection pattern has
    // headroom. Advisory locks each reserve 1 connection, so for N
    // concurrent holders we need at least N+few free connections.
    client = createRawPostgresClient({ connectionString: CONNECTION_STRING, max: 20 });
  });

  after(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await client.sql`SELECT pg_advisory_unlock_all()`;
  });

  it('INVARIANT: 50 sequential acquire/release cycles on advisory lock do not leak connections', async () => {
    // If connections leak, the 51st acquire hangs because `pool.reserve()`
    // can't get a slot. We use a wide timeout to catch that.
    const provider = createPostgresLockProvider(client, { strategy: 'advisory' });
    const key = `stress-seq:${randomUUID().slice(0, 8)}`;
    const start = Date.now();

    for (let i = 0; i < 50; i++) {
      const meta = await provider.acquire(key, opts(), `inst-${i}`);
      assert.ok(meta, `cycle ${i}: acquire must succeed`);
      await provider.release(key, `inst-${i}`);
    }

    const total = Date.now() - start;
    assert.ok(total < 30_000, `50 cycles should complete reasonably (${total}ms)`);

    await provider.close();
  });

  it('INVARIANT: 10 concurrent acquires on 5 keys serialize per-key without deadlock', async () => {
    const provider = createPostgresLockProvider(client, { strategy: 'advisory' });
    const KEYS = 5;
    const WORKERS = 10;
    const baseKey = `stress-par:${randomUUID().slice(0, 8)}`;

    const perKeyConcurrent = new Map<string, number>();
    const perKeyPeak = new Map<string, number>();
    const perKeyCompleted = new Map<string, number>();

    const tasks = Array.from({ length: WORKERS }, (_, i) => {
      const keyIdx = i % KEYS;
      const key = `${baseKey}:${keyIdx}`;
      return (async () => {
        await provider.acquire(key, opts(), `inst-${i}`);
        perKeyConcurrent.set(key, (perKeyConcurrent.get(key) ?? 0) + 1);
        perKeyPeak.set(
          key,
          Math.max(perKeyPeak.get(key) ?? 0, perKeyConcurrent.get(key) ?? 0),
        );
        // Very short critical section.
        for (let k = 0; k < 3; k++) await Promise.resolve();
        perKeyConcurrent.set(key, (perKeyConcurrent.get(key) ?? 0) - 1);
        perKeyCompleted.set(key, (perKeyCompleted.get(key) ?? 0) + 1);
        await provider.release(key, `inst-${i}`);
      })();
    });

    await Promise.all(tasks);

    for (const [, peak] of perKeyPeak) {
      assert.strictEqual(peak, 1, 'per-key peak concurrency must be 1');
    }
    // WORKERS distributed over KEYS -> each key sees 2 completions.
    for (let i = 0; i < KEYS; i++) {
      assert.strictEqual(
        perKeyCompleted.get(`${baseKey}:${i}`) ?? 0,
        WORKERS / KEYS,
        `key ${i} must have ${WORKERS / KEYS} completions`,
      );
    }

    await provider.close();
  });

  it('INVARIANT: table lock - 50 sequential cycles do not leak rows or connections', async () => {
    const tableName = `stress_table_${randomUUID().slice(0, 8).replace(/-/g, '_')}`;
    try {
      await client.sql.unsafe(`
        CREATE TABLE ${tableName} (
          lock_key VARCHAR(512) PRIMARY KEY,
          instance_id VARCHAR(255) NOT NULL,
          fencing_token BIGINT NOT NULL DEFAULT 1,
          expires_at TIMESTAMPTZ NOT NULL,
          heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.sql.unsafe(
        'CREATE SEQUENCE IF NOT EXISTS global_fencing_token START 1 INCREMENT 1 CACHE 100',
      );

      const provider = createPostgresLockProvider(client, {
        strategy: 'table',
        tableName,
      });

      const key = `stress-tbl:${randomUUID().slice(0, 8)}`;
      for (let i = 0; i < 50; i++) {
        await provider.acquire(key, opts(), `inst-${i}`);
        await provider.release(key, `inst-${i}`);
      }

      // No rows should remain for this key.
      const rows = await client.sql.unsafe(
        `SELECT * FROM ${tableName} WHERE lock_key = '${key}'`,
      );
      assert.strictEqual(rows.length, 0, 'no rows after 50 cycles');

      await provider.close();
    } finally {
      await client.sql.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
    }
  });

  it('INVARIANT: 10 acquires on 10 distinct keys in parallel - all finish, pool not exhausted', async () => {
    // One advisory-lock holder reserves 1 pool connection. With max=20
    // we should easily handle 10 simultaneous holders.
    const provider = createPostgresLockProvider(client, { strategy: 'advisory' });
    const base = `stress-distinct:${randomUUID().slice(0, 8)}`;

    const tasks = Array.from({ length: 10 }, (_, i) =>
      (async () => {
        const key = `${base}:${i}`;
        const meta = await provider.acquire(key, opts(), `inst-${i}`);
        assert.ok(meta);
        // Hold briefly.
        await new Promise((r) => setTimeout(r, 20));
        await provider.release(key, `inst-${i}`);
      })(),
    );

    const start = Date.now();
    await Promise.all(tasks);
    const elapsed = Date.now() - start;
    // All run in parallel, so total ~= 20ms hold + roundtrip overhead.
    assert.ok(elapsed < 5_000, `parallel distinct-key acquires should be fast; took ${elapsed}ms`);

    await provider.close();
  });
});
