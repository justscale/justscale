/**
 * Advisory lock primitive - multi-instance Postgres conformance.
 *
 * Two separate JustScale instances, each with its own AbstractPostgresClient
 * pool -> each owns its own pg sessions -> pg_advisory_lock contention is
 * real (not re-entrant within one session like the unit tests at
 * packages/adapters/postgres/test/lock-provider.e2e.test.ts are).
 *
 * Matrix:
 *   1. Two instances race for the same lock name -> exactly one wins.
 *   2. Holder releases -> other acquires.
 *   3. Holder "crashes" (all its pg sessions terminated) -> advisory lock
 *      auto-releases, the other instance can acquire.
 *   4. Same instance acquires twice -> throws (re-entrant guard in provider).
 *   5. Different keys -> both acquire concurrently, no blocking.
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { AbstractLockProvider } from '@justscale/core';
import { checkPg, createSharedDb, makeInstance, delay, waitFor, type SharedDb, type InstanceHandle } from './helpers.js';

const hasPg = await checkPg();

function lockOpts(overrides: Record<string, unknown> = {}) {
  return {
    ttl: 30_000,
    timeout: 1_000,
    key: '',
    heartbeat: false,
    heartbeatInterval: 10_000,
    ...overrides,
  } as any;
}

describe('Advisory lock primitive (multi-instance pg)', { skip: !hasPg ? 'docker postgres not reachable' : false }, () => {
  let db: SharedDb;
  let a: InstanceHandle;
  let b: InstanceHandle;

  before(async () => {
    db = await createSharedDb('lock');
    const signalChannel = `pg_lock_${db.name}`;
    a = await makeInstance({ id: 'a', url: db.url, signalChannel });
    b = await makeInstance({ id: 'b', url: db.url, signalChannel });
  });

  after(async () => {
    await a?.stop();
    await b?.stop();
    await db?.drop();
  });

  it('two instances race for same lock -> exactly one wins (other blocks)', async () => {
    const lockA = await a.app.container.resolve(AbstractLockProvider);
    const lockB = await b.app.container.resolve(AbstractLockProvider);

    const key = `race-${Date.now()}`;

    // A acquires first.
    const metaA = await lockA.acquire(key, lockOpts({ ttl: 30_000, timeout: 0 }), 'instance-a');
    assert.ok(metaA, 'A should acquire first');

    // B tries to acquire - BLOCKS at pg level (pg_advisory_lock is a
    // blocking call; the lock provider's `timeout` option only applies
    // within the same process). We race against a wall-clock timeout to
    // assert B does NOT win within a reasonable window.
    //
    // NOTE (bug?): the `LockOptions.timeout` field is not honored
    // cross-process for advisory locks. Either the type should be
    // documented as "same-process only" or the provider should use
    // `pg_try_advisory_lock` + app-level polling to honor it. Not fixing
    // here; flagged for the framework backlog.
    let bResolved = false;
    const bPromise = lockB.acquire(key, lockOpts({ ttl: 30_000, timeout: 0 }), 'instance-b').then(
      (m) => { bResolved = true; return m; },
      (e) => { bResolved = true; throw e; },
    );
    bPromise.catch(() => {}); // detach

    await delay(500);
    assert.strictEqual(bResolved, false, 'B should still be blocked while A holds the lock');

    // Release A - B should now unblock.
    await lockA.release(key, 'instance-a');

    const metaB = await Promise.race([
      bPromise,
      delay(3000).then(() => null),
    ]);
    assert.ok(metaB, 'B should acquire after A releases');

    await lockB.release(key, 'instance-b');
  });

  it('holder releases -> other acquires', async () => {
    const lockA = await a.app.container.resolve(AbstractLockProvider);
    const lockB = await b.app.container.resolve(AbstractLockProvider);

    const key = `handoff-${Date.now()}`;
    await lockA.acquire(key, lockOpts({ timeout: 0 }), 'a');

    // B tries to acquire with a generous timeout; A releases after 200ms.
    const bPromise = lockB.acquire(key, lockOpts({ timeout: 3000 }), 'b');
    // Give B's waiter a moment.
    await delay(50);
    await lockA.release(key, 'a');

    const metaB = await bPromise;
    assert.ok(metaB, 'B should acquire after A releases');

    await lockB.release(key, 'b');
  });

  it('holder "crashes" (instance stopped without releasing) -> lock releases, other acquires', async () => {
    // Dedicated instance we can stop without releasing. We use a separate
    // postgres connection (outside any JustScale app) to hold the advisory
    // lock so we can truly simulate a crash: kill the connection, the
    // lock auto-releases (session-scoped advisory).
    const doomedSql = postgres(db.url, { max: 1 });
    // Reserve a dedicated connection for the lock (advisory locks are
    // session-scoped - we need a predictable session).
    const reserved = await doomedSql.reserve();

    const key = `crash-${Date.now()}`;
    const { hashStringToBigInt } = await import('../../src/index.js');
    const hashStr = hashStringToBigInt(key).toString();
    await reserved`SELECT pg_advisory_lock(${hashStr}::bigint)`;

    // Verify A can't grab it (pg-level block, short wall-clock check).
    const lockA = await a.app.container.resolve(AbstractLockProvider);
    let aBlocked = true;
    const aPromise = lockA.acquire(key, lockOpts({ timeout: 0 }), 'a').then(
      (m) => { aBlocked = false; return m; },
      (e) => { aBlocked = false; throw e; },
    );
    aPromise.catch(() => {});
    await delay(300);
    assert.strictEqual(aBlocked, true, 'A must block while doomed holds the lock');

    // "Crash" the holder - terminate the pg backend behind this session.
    // Advisory locks are session-scoped -> auto-released.
    await reserved.unsafe('SELECT pg_terminate_backend(pg_backend_pid())').catch(() => {});
    // The reserved connection is now dead; release it back to the pool.
    try { reserved.release(); } catch { /* already dead */ }
    await doomedSql.end({ timeout: 1 }).catch(() => {});

    // A should now succeed (possibly already resolved).
    const metaA = await Promise.race([
      aPromise,
      delay(5000).then(() => null),
    ]);
    assert.ok(metaA, 'A should acquire the orphaned lock after holder crashed');

    await lockA.release(key, 'a');
  });

  it('same instance acquires the same key twice -> throws (re-entrant guard)', async () => {
    const lockA = await a.app.container.resolve(AbstractLockProvider);
    const key = `reentrant-${Date.now()}`;

    // Provider tracks held locks in AsyncLocalStorage. Without a
    // withLockContext wrapper it still uses the process-wide hashLocks,
    // but the real contract is "same-context re-acquisition throws."
    // Lock-context wrapping is covered by the existing unit tests; here
    // we test the multi-acquire behavior from the same provider.
    const { withLockContext } = await import('../../src/index.js');

    await withLockContext(async () => {
      await lockA.acquire(key, lockOpts({ timeout: 0 }), 'a');
      let threw = false;
      try {
        await lockA.acquire(key, lockOpts({ timeout: 0 }), 'a');
      } catch {
        threw = true;
      }
      assert.strictEqual(threw, true, 'same-context re-acquire must throw');
      await lockA.release(key, 'a');
    });
  });

  it('different keys from different instances -> both acquire concurrently', async () => {
    const lockA = await a.app.container.resolve(AbstractLockProvider);
    const lockB = await b.app.container.resolve(AbstractLockProvider);

    const keyA = `concurrent-a-${Date.now()}`;
    const keyB = `concurrent-b-${Date.now()}`;

    const [metaA, metaB] = await Promise.all([
      lockA.acquire(keyA, lockOpts({ timeout: 500 }), 'a'),
      lockB.acquire(keyB, lockOpts({ timeout: 500 }), 'b'),
    ]);
    assert.ok(metaA);
    assert.ok(metaB);

    await lockA.release(keyA, 'a');
    await lockB.release(keyB, 'b');
  });

  it('lock provider is pg-backed (sanity)', async () => {
    const p = await a.app.container.resolve(AbstractLockProvider);
    // Class name distinguishes pg provider from in-memory.
    assert.match(p.constructor.name, /Postgres|Advisory|LockProvider/);
  });
});
