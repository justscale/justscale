/**
 * Reentrance — same-context double-lock must be detected, cross-context must
 * block instead of throwing.
 *
 * This is the DoubleLockError contract (see design-double-lock-detection.md).
 * The detection runs at the LockService layer via AsyncLocalStorage. Failure
 * modes we're guarding against:
 *
 * - Accept silent reentrance → process re-enters its own critical section,
 *   reads partially-mutated state, producing "looks-like-it-works" corruption.
 * - Reject cross-context acquires by treating them as reentrance → concurrent
 *   HTTP requests needing the same resource would spuriously throw instead
 *   of serializing through the lock.
 *
 * The service-level test exercises heldLocks AsyncLocalStorage directly
 * without standing up a DI container.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryLockProvider } from '../../../src/features/lock/memory.js';
import {
  DoubleLockError,
  runWithLockTracking,
  getHeldLocks,
} from '../../../src/features/lock/lock-service.js';
import type { LockOptions, LockProvider, Lock, LockMetadata } from '../../../src/features/lock/types.js';

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
 * A minimal LockService-like wrapper that reproduces the exact detection
 * path in lock-service.ts. We reproduce it here because the real
 * LockServiceImpl is not exported and requires DI plumbing. If the real
 * service changes its detection logic, this test's passing/failing is no
 * longer meaningful — a follow-up would be to export the class for testing.
 */
function createTrackedAcquire(provider: LockProvider) {
  const instanceId = 'test-instance';
  return async function acquire<T extends object>(
    obj: T,
    options: Required<LockOptions>,
  ): Promise<Lock<T>> {
    const held = getHeldLocks() as Set<string> | undefined;
    if (held?.has(options.key)) {
      throw new DoubleLockError(options.key);
    }
    const metadata = await provider.acquire(options.key, options, instanceId);
    held?.add(options.key);
    const locked = Object.create(obj as object, {
      __lock: { value: metadata, writable: false, enumerable: false, configurable: false },
      [Symbol.dispose]: {
        value: function () {
          held?.delete(options.key);
          provider.release(options.key, instanceId).catch(() => {});
        },
        writable: false,
        enumerable: false,
        configurable: false,
      },
    });
    return locked as Lock<T> & { __lock: LockMetadata };
  };
}

describe('LockService — reentrance (DoubleLockError)', () => {
  it('INVARIANT: same async context, same key → DoubleLockError on second acquire', async () => {
    const lp = createInMemoryLockProvider();
    const acquire = createTrackedAcquire(lp);

    await runWithLockTracking(async () => {
      const first = await acquire({ id: 'order-1' }, opts({ key: 'lock:Order:1' }));
      assert.ok(first.__lock);

      let threw: unknown;
      try {
        await acquire({ id: 'order-1' }, opts({ key: 'lock:Order:1' }));
      } catch (err) {
        threw = err;
      }
      assert.ok(threw instanceof DoubleLockError,
        'second same-context acquire must throw DoubleLockError');
      assert.strictEqual((threw as DoubleLockError).lockKey, 'lock:Order:1');

      first[Symbol.dispose]();
    });
  });

  it('INVARIANT: after dispose, same context can re-acquire same key (no permanent ban)', async () => {
    // DoubleLockError must NOT be sticky. After disposal, the key is free
    // for the same context to re-acquire in the next critical section.
    const lp = createInMemoryLockProvider();
    const acquire = createTrackedAcquire(lp);

    await runWithLockTracking(async () => {
      const a = await acquire({ id: '1' }, opts({ key: 'lock:Order:1' }));
      a[Symbol.dispose]();
      // Give the fire-and-forget release a tick.
      await delay(5);

      // Re-acquire must succeed.
      const b = await acquire({ id: '1' }, opts({ key: 'lock:Order:1' }));
      assert.ok(b.__lock);
      b[Symbol.dispose]();
    });
  });

  it('INVARIANT: different async contexts (parallel) do NOT trigger DoubleLockError — they serialize', async () => {
    // This is the bug DoubleLockError design explicitly avoids: treating
    // two parallel HTTP requests for the same row as "re-entrance" and
    // throwing on one of them. They should queue via the provider.
    const lp = createInMemoryLockProvider();
    const acquire = createTrackedAcquire(lp);

    const key = 'lock:Shared';

    const errors: unknown[] = [];
    const timeline: string[] = [];

    const taskA = runWithLockTracking(async () => {
      try {
        const a = await acquire({ id: 'x' }, opts({ key }));
        timeline.push('A-entered');
        await delay(40);
        timeline.push('A-leaving');
        a[Symbol.dispose]();
      } catch (err) {
        errors.push(err);
      }
    });

    const taskB = runWithLockTracking(async () => {
      try {
        await delay(10);
        const b = await acquire({ id: 'x' }, opts({ key }));
        timeline.push('B-entered');
        await delay(20);
        timeline.push('B-leaving');
        b[Symbol.dispose]();
      } catch (err) {
        errors.push(err);
      }
    });

    await Promise.all([taskA, taskB]);

    assert.deepStrictEqual(errors, [],
      'parallel different-context acquires must not produce DoubleLockError');
    assert.deepStrictEqual(timeline, [
      'A-entered', 'A-leaving', 'B-entered', 'B-leaving',
    ], 'B must block until A releases');
  });

  it('INVARIANT: different keys in same context do NOT false-positive', async () => {
    const lp = createInMemoryLockProvider();
    const acquire = createTrackedAcquire(lp);

    await runWithLockTracking(async () => {
      const a = await acquire({ id: '1' }, opts({ key: 'lock:A' }));
      const b = await acquire({ id: '2' }, opts({ key: 'lock:B' }));
      const c = await acquire({ id: '3' }, opts({ key: 'lock:C' }));

      assert.ok(a.__lock);
      assert.ok(b.__lock);
      assert.ok(c.__lock);

      a[Symbol.dispose]();
      b[Symbol.dispose]();
      c[Symbol.dispose]();
    });
  });

  it('INVARIANT: outside runWithLockTracking, detection is silently skipped (legacy call sites keep working)', async () => {
    // If a caller forgets to wrap their work in runWithLockTracking, the
    // LockService must NOT throw — it simply loses the detection. Better
    // to silently miss a rare bug than break every unwrapped caller.
    const lp = createInMemoryLockProvider();
    const acquire = createTrackedAcquire(lp);

    // No runWithLockTracking wrapper.
    const a = await acquire({ id: '1' }, opts({ key: 'lock:Unwrapped' }));
    assert.ok(a.__lock);
    // Second acquire in same context: provider would normally block, so use
    // a different key to verify we didn't throw.
    const b = await acquire({ id: '2' }, opts({ key: 'lock:Unwrapped-2' }));
    assert.ok(b.__lock);

    a[Symbol.dispose]();
    b[Symbol.dispose]();
  });

  it('INVARIANT: getHeldLocks reports exactly the keys held in this context', async () => {
    const lp = createInMemoryLockProvider();
    const acquire = createTrackedAcquire(lp);

    await runWithLockTracking(async () => {
      const held = getHeldLocks()!;
      assert.strictEqual(held.size, 0);

      const a = await acquire({ id: '1' }, opts({ key: 'lock:A' }));
      assert.ok(getHeldLocks()!.has('lock:A'));
      assert.strictEqual(getHeldLocks()!.size, 1);

      const b = await acquire({ id: '2' }, opts({ key: 'lock:B' }));
      assert.strictEqual(getHeldLocks()!.size, 2);

      a[Symbol.dispose]();
      // Dispose is synchronous removal from held set (release is fire-and-forget).
      assert.ok(!getHeldLocks()!.has('lock:A'));
      assert.ok(getHeldLocks()!.has('lock:B'));

      b[Symbol.dispose]();
      assert.strictEqual(getHeldLocks()!.size, 0);
    });
  });

  it('INVARIANT: nested runWithLockTracking creates isolated scopes (inner sees empty held set)', async () => {
    // The AsyncLocalStorage `.run()` semantics create a fresh store per run.
    // If a developer nests runWithLockTracking intentionally, the inner
    // block must get a fresh set — otherwise "scoped" tracking is a lie.
    const lp = createInMemoryLockProvider();
    const acquire = createTrackedAcquire(lp);

    await runWithLockTracking(async () => {
      const outer = await acquire({ id: '1' }, opts({ key: 'lock:outer' }));

      await runWithLockTracking(async () => {
        // In the inner scope, the outer lock is NOT tracked.
        assert.strictEqual(getHeldLocks()!.size, 0);
        // So acquiring the same key does NOT trigger double-lock at the
        // tracking layer. (The provider would, of course, block — so we
        // use a different key to prove the detection layer is isolated.)
        const innerOther = await acquire({ id: '2' }, opts({ key: 'lock:inner' }));
        assert.strictEqual(getHeldLocks()!.size, 1);
        innerOther[Symbol.dispose]();
      });

      // Outer scope still has its lock tracked.
      assert.ok(getHeldLocks()!.has('lock:outer'));
      outer[Symbol.dispose]();
    });
  });
});
