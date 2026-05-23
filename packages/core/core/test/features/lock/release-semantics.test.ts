/**
 * Release semantics — what exactly happens on the UNLOCK side.
 *
 * Locks that silently "succeed" on double-release, release-without-acquire,
 * or release-by-wrong-owner can mask logic bugs (ownership leaked to the
 * wrong caller, using-disposal racing with manual release, etc.). These
 * tests pin down the documented behavior so a future "optimization" can't
 * flip it accidentally.
 *
 * Documented behavior of InMemoryLockProvider (per memory.ts):
 * - release by wrong instanceId → silent no-op
 * - release of non-existent key → silent no-op
 * - double release → second release is a silent no-op
 * - release notifies waiters
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

describe('InMemoryLockProvider — release semantics', () => {
  it('INVARIANT: release of a non-existent key is a no-op, not a throw', async () => {
    // Callers MUST be able to `await release()` in finally blocks without
    // needing to guard. Throwing here would mean disposal surfaces errors.
    const lp = createInMemoryLockProvider();

    await lp.release('never-acquired', 'some-instance'); // must not throw
    assert.strictEqual(lp.isLocked('never-acquired'), false);
  });

  it('INVARIANT: double release is a no-op (second call does nothing)', async () => {
    // Symbol.dispose + manual release can legitimately both fire. Second
    // call must not throw, must not re-notify waiters for a fresh acquisition.
    const lp = createInMemoryLockProvider();
    const key = 'rel:double';

    await lp.acquire(key, opts(), 'owner');
    await lp.release(key, 'owner');
    await lp.release(key, 'owner'); // second release
    await lp.release(key, 'owner'); // third release

    assert.strictEqual(lp.isLocked(key), false);
    assert.strictEqual(lp.size, 0);
  });

  it('INVARIANT: release by a different instanceId does NOT release the lock (ownership check)', async () => {
    // This is security-critical. If we let any caller release anyone's
    // lock, a buggy module could tank another module's critical section.
    const lp = createInMemoryLockProvider();
    const key = 'rel:wrong-owner';

    await lp.acquire(key, opts(), 'real-owner');
    await lp.release(key, 'impostor'); // should be silently ignored

    assert.strictEqual(lp.isLocked(key), true, 'lock must still be held');
    assert.strictEqual(lp.getLockedBy(key), 'real-owner');

    // The real owner can still release.
    await lp.release(key, 'real-owner');
    assert.strictEqual(lp.isLocked(key), false);
  });

  it('INVARIANT: release wakes up waiters, who then re-acquire', async () => {
    // This is how a held lock "completes" — the release edge triggers
    // a waiter resume. Without this, waiters block forever.
    const lp = createInMemoryLockProvider();
    const key = 'rel:wake';

    await lp.acquire(key, opts(), 'holder');

    let waiterDone = false;
    const waiter = (async () => {
      await lp.acquire(key, opts(), 'waiter');
      waiterDone = true;
      await lp.release(key, 'waiter');
    })();

    await delay(20);
    assert.strictEqual(waiterDone, false, 'waiter must block while lock held');

    await lp.release(key, 'holder');
    await waiter;

    assert.strictEqual(waiterDone, true, 'waiter must resume after release');
    assert.strictEqual(lp.isLocked(key), false);
  });

  it('INVARIANT: release by wrong owner does NOT wake up waiters', async () => {
    // Consequence of the ownership check: a wrong-owner release must NOT
    // notify waiters (otherwise spurious wakeups would try to acquire a
    // still-held lock, then re-block — wastes CPU but more importantly,
    // masks bugs about who "owns" the signal to release).
    const lp = createInMemoryLockProvider();
    const key = 'rel:wake-unauthorized';

    await lp.acquire(key, opts(), 'real');

    let waiterDone = false;
    const waiter = (async () => {
      await lp.acquire(key, opts(), 'waiter');
      waiterDone = true;
      await lp.release(key, 'waiter');
    })();

    await delay(20);
    await lp.release(key, 'impostor'); // unauthorized
    await delay(30);

    assert.strictEqual(waiterDone, false,
      'waiter must not resume on unauthorized release');

    await lp.release(key, 'real');
    await waiter;
    assert.strictEqual(waiterDone, true);
  });

  it('INVARIANT: after release, size reflects removed entry', async () => {
    const lp = createInMemoryLockProvider();

    await lp.acquire('a', opts(), 'x');
    await lp.acquire('b', opts(), 'x');
    await lp.acquire('c', opts(), 'x');
    assert.strictEqual(lp.size, 3);

    await lp.release('b', 'x');
    assert.strictEqual(lp.size, 2);

    await lp.release('a', 'x');
    await lp.release('c', 'x');
    assert.strictEqual(lp.size, 0);
  });

  it('INVARIANT: release during/after TTL expiry is still safe (no throw)', async () => {
    // Expiration and manual release race in real code. Both paths must be safe.
    const lp = createInMemoryLockProvider();
    const key = 'rel:expiry-race';

    await lp.acquire(key, opts({ ttl: 30 }), 'owner');
    await delay(60); // lock definitely expired
    await lp.release(key, 'owner'); // must not throw

    assert.strictEqual(lp.isLocked(key), false);
  });

  it('INVARIANT: Disposable release (Symbol.dispose path) matches manual release', async () => {
    // createInMemoryLockProvider returns the low-level provider, so
    // Symbol.dispose behavior is at the LockService layer. This test
    // instead verifies the low-level release path is idempotent enough
    // to cover what the dispose handler invokes.
    const lp = createInMemoryLockProvider();
    const key = 'rel:disposable';

    await lp.acquire(key, opts(), 'owner');

    // Simulate the exact dispose sequence: fire-and-forget release.
    const p = lp.release(key, 'owner');
    // Caller awaits too — must not double-release errors.
    await p;
    await lp.release(key, 'owner');

    assert.strictEqual(lp.isLocked(key), false);
  });
});
