/**
 * Lock lifetime — TTL expiry and simulated "crash" semantics.
 *
 * A lock whose holder dies must eventually become acquirable by someone else;
 * otherwise one crashed process freezes an entire key forever. TTL is how the
 * in-memory provider approximates session termination. These tests pin down:
 *
 * - a lock EXPIRES after TTL
 * - a held-then-expired lock is acquirable by ANOTHER instance
 * - extend() resets the expiry and prevents takeover
 * - extend() on a non-owned lock is rejected
 * - close() releases every lock (simulates graceful shutdown)
 * - clear() notifies all waiters (simulates "crash" that fires disposal)
 *
 * A silently-broken TTL would mean "crash → permanent deadlock", which only
 * shows up in a production incident, not a test suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryLockProvider } from '../../../src/features/lock/memory.js';
import type { LockOptions } from '../../../src/features/lock/types.js';

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

describe('InMemoryLockProvider — lifetime & expiry', () => {
  it('INVARIANT: lock is released when TTL elapses (auto-expiry timer)', async () => {
    const lp = createInMemoryLockProvider();
    const key = 'life:ttl';

    await lp.acquire(key, opts({ ttl: 40 }), 'holder');
    assert.strictEqual(lp.isLocked(key), true);

    await delay(80);

    assert.strictEqual(lp.isLocked(key), false,
      'lock should be auto-released after TTL');
    assert.strictEqual(lp.size, 0);
  });

  it('INVARIANT: after TTL expiry, a different instance can acquire — no deadlock', async () => {
    // This is the "crash recovery" story for in-memory: holder disappears
    // (we simulate by not releasing), TTL fires, someone else gets the lock.
    const lp = createInMemoryLockProvider();
    const key = 'life:recovery';

    await lp.acquire(key, opts({ ttl: 50 }), 'dead-instance');
    // Deliberately do NOT release.

    const start = Date.now();
    await lp.acquire(key, opts({ ttl: 30_000 }), 'new-instance');
    const waited = Date.now() - start;

    assert.ok(waited >= 30,
      `should wait at least close to TTL (${waited}ms)`);
    // Wide upper bound — timer may run slightly late.
    assert.ok(waited < 500, `should not wait forever, took ${waited}ms`);

    assert.strictEqual(lp.getLockedBy(key), 'new-instance',
      'new instance must be recorded as owner');

    await lp.release(key, 'new-instance');
  });

  it('INVARIANT: extend() resets expiry and prevents takeover', async () => {
    const lp = createInMemoryLockProvider();
    const key = 'life:extend';

    await lp.acquire(key, opts({ ttl: 50 }), 'holder');

    // Wait a bit, then extend — now lock should live for another ~200ms.
    await delay(30);
    const ok = await lp.extend(key, 'holder', 200);
    assert.strictEqual(ok, true);

    // After the ORIGINAL TTL would have elapsed, lock must still be held.
    await delay(40); // total 70ms > original 50ms
    assert.strictEqual(lp.isLocked(key), true,
      'extend() must reset expiry — lock still held past original TTL');
    assert.strictEqual(lp.getLockedBy(key), 'holder');

    await lp.release(key, 'holder');
  });

  it('INVARIANT: extend() by wrong instance returns false and does NOT extend', async () => {
    // A different instance must not be able to keep a lock alive that it
    // does not own — otherwise any caller could starve waiters.
    const lp = createInMemoryLockProvider();
    const key = 'life:extend-wrong';

    await lp.acquire(key, opts({ ttl: 50 }), 'real-owner');
    const ok = await lp.extend(key, 'impostor', 30_000);
    assert.strictEqual(ok, false);

    // Lock must expire on its original schedule.
    await delay(100);
    assert.strictEqual(lp.isLocked(key), false,
      'unauthorized extend must not have reset expiry');
  });

  it('INVARIANT: extend() on a non-existent lock returns false, not throw', async () => {
    const lp = createInMemoryLockProvider();
    const ok = await lp.extend('nothing-here', 'anyone', 30_000);
    assert.strictEqual(ok, false);
  });

  it('INVARIANT: expiry notifies waiters so they can acquire', async () => {
    // Critical for deadlock-freedom: if holder dies silently, TTL must
    // not only expire the entry but also wake up anyone waiting.
    const lp = createInMemoryLockProvider();
    const key = 'life:expiry-notify';

    await lp.acquire(key, opts({ ttl: 80 }), 'dead');

    const start = Date.now();
    const waiterAcquiredAt = (async () => {
      await lp.acquire(key, opts({ ttl: 30_000 }), 'waiter');
      return Date.now();
    })();

    const at = await waiterAcquiredAt;
    const waited = at - start;
    // Should resume once TTL fires (around 80ms), not 30s later.
    assert.ok(waited >= 70,
      `should wait at least until expiry (${waited}ms)`);
    assert.ok(waited < 1000,
      `should not wait forever; waited ${waited}ms`);

    await lp.release(key, 'waiter');
  });

  it('INVARIANT: close() releases all held locks (graceful shutdown)', async () => {
    const lp = createInMemoryLockProvider();

    await lp.acquire('k1', opts(), 'a');
    await lp.acquire('k2', opts(), 'a');
    await lp.acquire('k3', opts(), 'a');
    assert.strictEqual(lp.size, 3);

    await lp.close();
    assert.strictEqual(lp.size, 0, 'close() must release everything');

    // Must be safe to acquire again after close() (provider reusable as Map).
    await lp.acquire('k4', opts(), 'b');
    assert.strictEqual(lp.isLocked('k4'), true);
    await lp.release('k4', 'b');
  });

  it('INVARIANT: clear() on a held lock wakes all waiters (simulated crash reset)', async () => {
    // `clear()` models a test-reset or a provider-level failure. The
    // provider must NOT leave waiters stuck.
    const lp = createInMemoryLockProvider();
    const key = 'life:clear-wakes';

    await lp.acquire(key, opts(), 'holder');

    let waiterAcquired = false;
    const waiter = (async () => {
      await lp.acquire(key, opts({ ttl: 30_000 }), 'waiter');
      waiterAcquired = true;
      await lp.release(key, 'waiter');
    })();

    await delay(20);
    assert.strictEqual(waiterAcquired, false);

    lp.clear();

    // Waiter should resume shortly and acquire.
    await delay(50);
    assert.strictEqual(waiterAcquired, true,
      'clear() must notify waiters so they can re-acquire');

    await waiter;
  });

  it('INVARIANT: TTL=1ms edge case does not deadlock a subsequent acquire', async () => {
    // Very short TTLs expose race conditions between timer fire and
    // "synchronous check-and-set" in acquire.
    const lp = createInMemoryLockProvider();
    const key = 'life:tiny-ttl';

    for (let i = 0; i < 20; i++) {
      await lp.acquire(key, opts({ ttl: 1 }), `inst-${i}`);
      await delay(3);
      // Either release cleanly or it already expired — both paths must be safe.
      await lp.release(key, `inst-${i}`);
    }

    assert.strictEqual(lp.size, 0);
  });
});
