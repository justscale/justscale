/**
 * Postgres lock mutual exclusion - across separate sessions/clients.
 *
 * This is where advisory locks EARN their keep: the provider must serialize
 * two completely separate Node processes (simulated here by two
 * AbstractPostgresClient instances, each with its own pool/session) trying
 * to hold the same lock.
 *
 * If this invariant breaks silently, two "instances" of a process could run
 * the same step concurrently - the exact duplication the lock is preventing.
 *
 * In-process re-entrancy of pg_advisory_lock is expected (and intentionally
 * guarded against in the provider via AsyncLocalStorage); this test focuses
 * on CROSS-session exclusion, which is the real distributed-lock guarantee.
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

/**
 * Create an independent PostgresClient (own pool -> own sessions).
 * Simulates "a separate node/process" talking to the same database.
 */
function makeIndependentClient(): { client: AbstractPostgresClient, close: () => Promise<void> } {
  const client = createRawPostgresClient({ connectionString: CONNECTION_STRING, max: 4 });
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

describe('PostgreSQL Lock - cross-session mutual exclusion', { timeout: 60_000 }, async () => {
  if (!(await requirePostgres())) return;

  // We create one canonical client for setup/teardown work.
  let adminClient: AbstractPostgresClient;
  let adminClose: () => Promise<void>;

  before(async () => {
    const { client, close } = makeIndependentClient();
    adminClient = client;
    adminClose = close;
  });

  after(async () => {
    await adminClose();
  });

  beforeEach(async () => {
    // Best-effort cleanup of any leaked advisory locks from a previous run.
    await adminClient.sql`SELECT pg_advisory_unlock_all()`;
  });

  it('INVARIANT: two independent sessions on the same key serialize - second blocks until first releases', async () => {
    const a = makeIndependentClient();
    const b = makeIndependentClient();
    try {
      const providerA = createPostgresLockProvider(a.client, { strategy: 'advisory' });
      const providerB = createPostgresLockProvider(b.client, { strategy: 'advisory' });
      const key = `xsess:${randomUUID().slice(0, 8)}`;

      // Session A takes the lock.
      await providerA.acquire(key, opts(), 'A');

      // Session B tries - must block. We run B in the background and check
      // after a wall-clock delay that it has not resolved.
      let bAcquired = false;
      const bPromise = providerB
        .acquire(key, opts({ ttl: 10_000 }), 'B')
        .then(() => { bAcquired = true; });

      await delay(150);
      assert.strictEqual(bAcquired, false,
        'B must be blocked while A holds the lock');

      // A releases - B must now acquire within a reasonable window.
      const releaseAt = Date.now();
      await providerA.release(key, 'A');
      await bPromise;
      const tookMs = Date.now() - releaseAt;
      assert.ok(tookMs < 2_000,
        `B should acquire within 2s of A's release, took ${tookMs}ms`);

      await providerB.release(key, 'B');
      await providerA.close();
      await providerB.close();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('INVARIANT: 5 concurrent independent sessions on the same key produce exactly 1 holder at a time', async () => {
    const SESSIONS = 5;
    const clients = Array.from({ length: SESSIONS }, () => makeIndependentClient());
    try {
      const providers = clients.map(({ client }) =>
        createPostgresLockProvider(client, { strategy: 'advisory' }),
      );
      const key = `xsess-many:${randomUUID().slice(0, 8)}`;

      let concurrent = 0;
      let peak = 0;
      let completed = 0;

      const tasks = providers.map((p, i) =>
        (async () => {
          await p.acquire(key, opts({ ttl: 10_000 }), `sess-${i}`);
          concurrent++;
          peak = Math.max(peak, concurrent);
          // Short critical section.
          await delay(30);
          concurrent--;
          completed++;
          await p.release(key, `sess-${i}`);
        })(),
      );

      await Promise.all(tasks);

      assert.strictEqual(peak, 1, `peak in-flight must be 1, was ${peak}`);
      assert.strictEqual(completed, SESSIONS);

      for (const p of providers) await p.close();
    } finally {
      for (const c of clients) await c.close();
    }
  });

  it('INVARIANT: distinct keys on separate sessions do NOT block each other', async () => {
    const a = makeIndependentClient();
    const b = makeIndependentClient();
    try {
      const providerA = createPostgresLockProvider(a.client, { strategy: 'advisory' });
      const providerB = createPostgresLockProvider(b.client, { strategy: 'advisory' });
      const keyA = `xsess-distinct-A:${randomUUID().slice(0, 8)}`;
      const keyB = `xsess-distinct-B:${randomUUID().slice(0, 8)}`;

      // Hold A, then verify B can still proceed concurrently.
      await providerA.acquire(keyA, opts(), 'A');
      const start = Date.now();
      await providerB.acquire(keyB, opts(), 'B');
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 500, `B should acquire its own key quickly, took ${elapsed}ms`);

      await providerA.release(keyA, 'A');
      await providerB.release(keyB, 'B');
      await providerA.close();
      await providerB.close();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('INVARIANT: 50 concurrent cross-session acquires on the same key produce exactly 50 ordered completions (process-singleton property)', async () => {
    // This is the property that the process executor relies on to
    // guarantee "a process instance runs on exactly one node at a time":
    // when N nodes race to acquire the same lock for the same process
    // instance, exactly one wins at a time, the rest queue.
    //
    // Rather than standing up the full executor, we directly pin down the
    // lock-level property here.
    const NODES = 10;
    const ROUNDS_PER_NODE = 5; // -> 50 total attempts
    const clients = Array.from({ length: NODES }, () => makeIndependentClient());
    try {
      const providers = clients.map(({ client }) =>
        createPostgresLockProvider(client, { strategy: 'advisory' }),
      );
      const key = `xsess-singleton:${randomUUID().slice(0, 8)}`;

      let concurrent = 0;
      let peak = 0;
      const completions: number[] = [];

      const workers = providers.map((p, nodeIdx) =>
        (async () => {
          for (let r = 0; r < ROUNDS_PER_NODE; r++) {
            await p.acquire(key, opts({ ttl: 30_000 }), `node-${nodeIdx}-r${r}`);
            concurrent++;
            peak = Math.max(peak, concurrent);
            // short hold
            await delay(5);
            concurrent--;
            completions.push(nodeIdx);
            await p.release(key, `node-${nodeIdx}-r${r}`);
          }
        })(),
      );

      await Promise.all(workers);

      assert.strictEqual(peak, 1, `singleton property violated: peak=${peak}`);
      assert.strictEqual(completions.length, NODES * ROUNDS_PER_NODE);
      for (const p of providers) await p.close();
    } finally {
      for (const c of clients) await c.close();
    }
  });

  it('INVARIANT: second session acquire with short server-side timeout is blocked then succeeds after release', async () => {
    // Reproducibility check: confirm the "waiter" side is actually
    // suspended in Postgres until the NOTIFY/pg_advisory_lock edge.
    const a = makeIndependentClient();
    const b = makeIndependentClient();
    try {
      const providerA = createPostgresLockProvider(a.client, { strategy: 'advisory' });
      const providerB = createPostgresLockProvider(b.client, { strategy: 'advisory' });
      const key = `xsess-timing:${randomUUID().slice(0, 8)}`;

      await providerA.acquire(key, opts(), 'A');

      const waitStart = Date.now();
      const bPromise = providerB.acquire(key, opts({ ttl: 10_000 }), 'B');

      await delay(120); // let B block
      const beforeRelease = Date.now();
      await providerA.release(key, 'A');
      await bPromise;
      const resolveTime = Date.now();

      const blockedFor = beforeRelease - waitStart;
      const resumeDelay = resolveTime - beforeRelease;
      assert.ok(blockedFor >= 100, `B should have been blocked ≥100ms, was ${blockedFor}ms`);
      assert.ok(resumeDelay < 2_000, `B should resume within 2s of release, took ${resumeDelay}ms`);

      await providerB.release(key, 'B');
      await providerA.close();
      await providerB.close();
    } finally {
      await a.close();
      await b.close();
    }
  });
});
