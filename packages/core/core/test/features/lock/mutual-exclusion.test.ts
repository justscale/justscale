/**
 * Mutual Exclusion — the core contract of a lock primitive.
 *
 * These tests pin down the single property that justifies every other feature
 * of the lock API: at any instant in time, at most one caller holds the lock
 * for a given key. If this invariant breaks silently, process step execution
 * becomes non-atomic, signal delivery duplicates, and data-race bugs appear in
 * a repo.lock(x) block, all of which "look like they work" until they don't.
 *
 * Tested against InMemoryLockProvider directly (no DI plumbing) so failures
 * point at the provider, not the feature builder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryLockProvider } from '../../../src/features/lock/memory.js';
import type { LockOptions, LockProvider } from '../../../src/features/lock/types.js';

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

describe('InMemoryLockProvider — mutual exclusion', () => {
  it('INVARIANT: two concurrent acquires on same key serialize', async () => {
    // If both resolve before the first releases, the whole primitive is broken
    // and every consumer that relies on "lock-guarded mutation" is wrong.
    const lp = createInMemoryLockProvider();
    const key = 'mx:a';

    const timeline: string[] = [];

    const acquire1 = (async () => {
      await lp.acquire(key, opts(), 'inst-1');
      timeline.push('1-acquired');
      await delay(50);
      timeline.push('1-release');
      await lp.release(key, 'inst-1');
    })();

    const acquire2 = (async () => {
      // Give acquire1 a chance to win the first slot deterministically.
      await delay(5);
      await lp.acquire(key, opts(), 'inst-2');
      timeline.push('2-acquired');
      timeline.push('2-release');
      await lp.release(key, 'inst-2');
    })();

    await Promise.all([acquire1, acquire2]);

    assert.deepStrictEqual(timeline, [
      '1-acquired',
      '1-release',
      '2-acquired',
      '2-release',
    ], 'Second acquire must not complete while first still holds the lock');
  });

  it('INVARIANT: at any moment at most one holder exists, under 50 concurrent acquires', async () => {
    // Race everyone simultaneously. If the provider lets two through we'll
    // see concurrent > 1 at some point.
    const lp = createInMemoryLockProvider();
    const key = 'mx:b';

    let concurrent = 0;
    let peak = 0;
    let completed = 0;

    const tasks = Array.from({ length: 50 }, (_, i) =>
      (async () => {
        await lp.acquire(key, opts(), `inst-${i}`);
        concurrent++;
        peak = Math.max(peak, concurrent);
        // Tiny critical section; use a few microtasks to increase overlap chance.
        for (let k = 0; k < 3; k++) await Promise.resolve();
        concurrent--;
        completed++;
        await lp.release(key, `inst-${i}`);
      })()
    );

    await Promise.all(tasks);

    assert.strictEqual(peak, 1, `peak concurrency must be 1 but was ${peak}`);
    assert.strictEqual(completed, 50);
    assert.strictEqual((lp as LockProvider & { size: number }).size, 0,
      'no locks should remain held after test');
  });

  it('INVARIANT: different keys do not interfere — both proceed concurrently', async () => {
    // If keys are accidentally sharing state (global lock, hash collision
    // without isolation) this regresses.
    const lp = createInMemoryLockProvider();

    let aInside = false;
    let bInside = false;
    let bothInsideOnce = false;

    const taskA = (async () => {
      await lp.acquire('mx:key-a', opts(), 'inst-A');
      aInside = true;
      // Yield microtasks so task B gets a chance.
      for (let k = 0; k < 10; k++) await Promise.resolve();
      if (aInside && bInside) bothInsideOnce = true;
      aInside = false;
      await lp.release('mx:key-a', 'inst-A');
    })();

    const taskB = (async () => {
      await lp.acquire('mx:key-b', opts(), 'inst-B');
      bInside = true;
      for (let k = 0; k < 10; k++) await Promise.resolve();
      if (aInside && bInside) bothInsideOnce = true;
      bInside = false;
      await lp.release('mx:key-b', 'inst-B');
    })();

    await Promise.all([taskA, taskB]);

    assert.strictEqual(bothInsideOnce, true,
      'independent keys must be able to hold simultaneously');
  });

  it('INVARIANT: holder is blocking other waiters while executing its critical section', async () => {
    // Stronger than the first test: measure that a waiter is actually
    // suspended for (at least) the holder's sleep time.
    const lp = createInMemoryLockProvider();
    const key = 'mx:c';

    const holdMs = 120;

    await lp.acquire(key, opts(), 'holder');
    const holderReleaseAt = Date.now() + holdMs;

    const waiterStart = Date.now();
    const waiterPromise = (async () => {
      await lp.acquire(key, opts(), 'waiter');
      return Date.now();
    })();

    // Schedule release.
    setTimeout(() => {
      lp.release(key, 'holder');
    }, holdMs);

    const waiterGotLockAt = await waiterPromise;
    const waiterWaited = waiterGotLockAt - waiterStart;

    // Waiter must have waited at least close to holdMs.
    assert.ok(
      waiterWaited >= holdMs - 20,
      `waiter should have waited ~${holdMs}ms but waited ${waiterWaited}ms`,
    );
    // And must have gotten the lock after the holder released.
    assert.ok(
      waiterGotLockAt >= holderReleaseAt - 20,
      'waiter must not acquire before holder releases',
    );

    await lp.release(key, 'waiter');
  });

  it('INVARIANT: acquire on same key after release succeeds immediately', async () => {
    // Re-acquisition after clean release is the baseline of "the lock is
    // actually released and not leaked".
    const lp = createInMemoryLockProvider();
    const key = 'mx:reuse';

    for (let i = 0; i < 5; i++) {
      await lp.acquire(key, opts(), `inst-${i}`);
      await lp.release(key, `inst-${i}`);
    }

    // Timing assertion: a fresh acquire on an unlocked key should complete
    // in a single microtask roundtrip. Use a wide bound.
    const start = Date.now();
    await lp.acquire(key, opts(), 'inst-final');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `fresh acquire took ${elapsed}ms, expected <50ms`);

    await lp.release(key, 'inst-final');
  });

  it('INVARIANT: 3 waiters queued then notified all eventually succeed — none starve', async () => {
    const lp = createInMemoryLockProvider();
    const key = 'mx:queue';

    await lp.acquire(key, opts(), 'primary');

    const acquiredOrder: string[] = [];
    const waiters = ['w1', 'w2', 'w3'].map((id) =>
      (async () => {
        await lp.acquire(key, opts(), id);
        acquiredOrder.push(id);
        await delay(5);
        await lp.release(key, id);
      })()
    );

    // Let all waiters block.
    await delay(20);
    await lp.release(key, 'primary');

    await Promise.all(waiters);

    assert.strictEqual(acquiredOrder.length, 3, 'all waiters must eventually acquire');
    assert.strictEqual(new Set(acquiredOrder).size, 3, 'each waiter runs once');
  });
});
