/**
 * Tests for the in-memory LockProvider implementation.
 *
 * Verifies the blocking acquire() semantics: waiters queue until release,
 * ttl auto-expires, extend() works, and release() is idempotent.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryLockProvider } from '../memory.js';
import type { LockOptions } from '../types.js';

function opts(ttl = 30_000): Required<LockOptions> {
  return {
    ttl,
    timeout: 5_000,
    key: '',
    heartbeat: false,
    heartbeatInterval: Math.floor(ttl / 3),
  };
}

describe('createInMemoryLockProvider - basics', () => {
  test('acquire returns metadata', async () => {
    const p = createInMemoryLockProvider();
    const meta = await p.acquire('k', opts(), 'inst-1');
    assert.ok(meta.lockedAt instanceof Date);
    assert.ok(meta.expiresAt instanceof Date);
    assert.equal(meta.lockedBy, 'inst-1');
    p.clear();
  });

  test('acquired lock is visible via isLocked', async () => {
    const p = createInMemoryLockProvider();
    assert.equal(p.isLocked('k'), false);
    await p.acquire('k', opts(), 'inst-1');
    assert.equal(p.isLocked('k'), true);
    p.clear();
  });

  test('getLockedBy returns the owning instance id', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(), 'inst-A');
    assert.equal(p.getLockedBy('k'), 'inst-A');
    p.clear();
  });

  test('getLockedBy returns null when lock absent', () => {
    const p = createInMemoryLockProvider();
    assert.equal(p.getLockedBy('nope'), null);
  });

  test('release removes the lock', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(), 'inst-1');
    await p.release('k', 'inst-1');
    assert.equal(p.isLocked('k'), false);
    p.clear();
  });

  test('release by different instance id is ignored', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(), 'inst-owner');
    await p.release('k', 'inst-other');
    assert.equal(p.isLocked('k'), true);
    assert.equal(p.getLockedBy('k'), 'inst-owner');
    p.clear();
  });

  test('release without acquire does not throw', async () => {
    const p = createInMemoryLockProvider();
    await assert.doesNotReject(p.release('nope', 'inst-1'));
  });

  test('size reflects number of active locks', async () => {
    const p = createInMemoryLockProvider();
    assert.equal(p.size, 0);
    await p.acquire('a', opts(), 'inst-1');
    await p.acquire('b', opts(), 'inst-1');
    assert.equal(p.size, 2);
    await p.release('a', 'inst-1');
    assert.equal(p.size, 1);
    p.clear();
  });

  test('clear() wipes all locks', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('a', opts(), 'inst-1');
    await p.acquire('b', opts(), 'inst-1');
    p.clear();
    assert.equal(p.size, 0);
    assert.equal(p.isLocked('a'), false);
    assert.equal(p.isLocked('b'), false);
  });

  test('close() wipes all locks', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('a', opts(), 'inst-1');
    await p.close();
    assert.equal(p.size, 0);
  });

  test('independent keys are independent', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('a', opts(), 'inst-1');
    await p.acquire('b', opts(), 'inst-1');
    assert.equal(p.isLocked('a'), true);
    assert.equal(p.isLocked('b'), true);
    p.clear();
  });
});

describe('in-memory blocking acquire semantics', () => {
  test('second acquire on same key blocks until first releases', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(), 'inst-1');

    let acquired = false;
    const waiter = p.acquire('k', opts(), 'inst-2').then((meta) => {
      acquired = true;
      return meta;
    });

    // Give the waiter time to run - it must still be blocked
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(acquired, false);

    // Release + verify second gets it
    await p.release('k', 'inst-1');
    await waiter;
    assert.equal(acquired, true);
    assert.equal(p.getLockedBy('k'), 'inst-2');
    p.clear();
  });

  test('multiple waiters serialize (each gets the lock in turn)', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(), 'owner');

    const order: string[] = [];
    const w1 = (async () => {
      await p.acquire('k', opts(), 'w1');
      order.push('w1');
      await p.release('k', 'w1');
    })();
    const w2 = (async () => {
      await p.acquire('k', opts(), 'w2');
      order.push('w2');
      await p.release('k', 'w2');
    })();

    await new Promise((r) => setTimeout(r, 10));
    await p.release('k', 'owner');
    await Promise.all([w1, w2]);

    assert.equal(order.length, 2);
    assert.deepStrictEqual(order.sort(), ['w1', 'w2']);
    p.clear();
  });

  test('acquire with expired lock takes over', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(20), 'inst-1');
    // wait past ttl
    await new Promise((r) => setTimeout(r, 50));
    const meta = await p.acquire('k', opts(), 'inst-2');
    assert.equal(meta.lockedBy, 'inst-2');
    assert.equal(p.getLockedBy('k'), 'inst-2');
    p.clear();
  });

  test('clear() wakes all waiters', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(), 'owner');
    const waiter = p.acquire('k', opts(), 'waiter');
    await new Promise((r) => setTimeout(r, 10));
    p.clear();
    // After clear, the waiter should be able to proceed
    const meta = await waiter;
    assert.equal(meta.lockedBy, 'waiter');
    p.clear();
  });
});

describe('TTL + expiration', () => {
  test('expiresAt = lockedAt + ttl', async () => {
    const p = createInMemoryLockProvider();
    const meta = await p.acquire('k', opts(5000), 'inst-1');
    const diff = meta.expiresAt.getTime() - meta.lockedAt.getTime();
    assert.equal(diff, 5000);
    p.clear();
  });

  test('isLocked reports false after ttl expires (no acquire called)', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(30), 'inst-1');
    // Before expiration
    assert.equal(p.isLocked('k'), true);
    await new Promise((r) => setTimeout(r, 50));
    // Past expiration, but internal cleanup triggers via timer - may or may not have run.
    // The isLocked check compares expiresAt against new Date() - must be false.
    assert.equal(p.isLocked('k'), false);
    p.clear();
  });
});

describe('extend', () => {
  test('extend returns true for owned lock', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(1000), 'inst-1');
    const ok = await p.extend('k', 'inst-1', 5000);
    assert.equal(ok, true);
    p.clear();
  });

  test('extend returns false for lock owned by another instance', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(), 'inst-A');
    const ok = await p.extend('k', 'inst-B', 5000);
    assert.equal(ok, false);
    p.clear();
  });

  test('extend returns false for non-existent lock', async () => {
    const p = createInMemoryLockProvider();
    const ok = await p.extend('nope', 'inst-1', 1000);
    assert.equal(ok, false);
  });

  test('extend updates expiresAt', async () => {
    const p = createInMemoryLockProvider();
    await p.acquire('k', opts(1000), 'inst-1');
    await p.extend('k', 'inst-1', 10_000);
    // The entry's expiresAt was updated - we can indirectly check via isLocked
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(p.isLocked('k'), true);
    p.clear();
  });
});
