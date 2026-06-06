/**
 * Stress — throw volume at the lock primitive and verify it does not leak,
 * deadlock, or quietly drop work.
 *
 * These tests are deliberately conservative about timing (wide bounds) and
 * focus on counting invariants:
 *
 * - N sequential acquire/release cycles → provider.size returns to 0, every
 *   cycle recorded.
 * - M concurrent acquires on K keys → no deadlock, every acquire completes,
 *   per-key ordering is serial.
 * - Rapid interleaved clients → no cross-client contamination (no instance
 *   ends up "holding" a lock it didn't acquire).
 *
 * A silent failure here is the worst kind: the code appears to work under
 * low load and falls over at scale.
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

describe('InMemoryLockProvider — stress', () => {
  it('INVARIANT: 500 sequential acquire/release cycles leave no residue', async () => {
    const lp = createInMemoryLockProvider();
    const key = 'stress:seq';

    for (let i = 0; i < 500; i++) {
      const meta = await lp.acquire(key, opts(), `inst-${i}`);
      assert.ok(meta);
      await lp.release(key, `inst-${i}`);
    }

    assert.strictEqual(lp.size, 0, 'no locks left after 500 cycles');
    assert.strictEqual(lp.isLocked(key), false);
  });

  it('INVARIANT: 100 concurrent acquires on 10 keys — no deadlock, fair distribution (no key starves)', async () => {
    // Round-robin assign 100 tasks over 10 keys. Each task acquires, does a
    // tiny critical section, releases. We assert every task finishes, every
    // key gets exactly 10 holders, and peak concurrency per key is 1.
    const lp = createInMemoryLockProvider();
    const KEYS = 10;
    const TASKS = 100;

    const perKeyConcurrent: number[] = new Array(KEYS).fill(0);
    const perKeyPeak: number[] = new Array(KEYS).fill(0);
    const perKeyCount: number[] = new Array(KEYS).fill(0);

    const tasks = Array.from({ length: TASKS }, (_, i) => {
      const keyIdx = i % KEYS;
      const key = `stress:k${keyIdx}`;
      return (async () => {
        await lp.acquire(key, opts(), `inst-${i}`);
        perKeyConcurrent[keyIdx]++;
        perKeyPeak[keyIdx] = Math.max(perKeyPeak[keyIdx], perKeyConcurrent[keyIdx]);
        // Very short critical section, use microtasks to induce overlap.
        for (let k = 0; k < 2; k++) await Promise.resolve();
        perKeyConcurrent[keyIdx]--;
        perKeyCount[keyIdx]++;
        await lp.release(key, `inst-${i}`);
      })();
    });

    await Promise.all(tasks);

    for (let i = 0; i < KEYS; i++) {
      assert.strictEqual(perKeyPeak[i], 1,
        `key ${i} peak concurrency must be 1, was ${perKeyPeak[i]}`);
      assert.strictEqual(perKeyCount[i], 10,
        `key ${i} must have 10 completions, was ${perKeyCount[i]}`);
    }
    assert.strictEqual(lp.size, 0);
  });

  it('INVARIANT: rapid interleaved acquire/release from 10 "clients" on 5 keys has no cross-contamination', async () => {
    // Each "client" has its own loop. We verify every lock's lockedBy equals
    // the acquirer exactly during its hold, by sampling getLockedBy() right
    // after acquire and right before release from the same task.
    const lp = createInMemoryLockProvider();
    const CLIENTS = 10;
    const KEYS = 5;
    const CYCLES = 20;

    const violations: string[] = [];

    const clients = Array.from({ length: CLIENTS }, (_, c) =>
      (async () => {
        for (let i = 0; i < CYCLES; i++) {
          const key = `stress:shared-${(c + i) % KEYS}`;
          const instanceId = `client-${c}`;
          await lp.acquire(key, opts(), instanceId);
          const holderNow = lp.getLockedBy(key);
          if (holderNow !== instanceId) {
            violations.push(
              `client-${c} cycle-${i} key=${key}: expected holder ${instanceId} got ${holderNow}`,
            );
          }
          // Yield.
          await Promise.resolve();
          // Still ours?
          const holderStillNow = lp.getLockedBy(key);
          if (holderStillNow !== instanceId) {
            violations.push(
              `client-${c} cycle-${i} key=${key}: ownership changed during hold to ${holderStillNow}`,
            );
          }
          await lp.release(key, instanceId);
        }
      })()
    );

    await Promise.all(clients);

    assert.deepStrictEqual(violations, [], 'no cross-client ownership contamination');
    assert.strictEqual(lp.size, 0);
  });

  it('INVARIANT: 200 concurrent acquires on ONE key all eventually finish (no starvation)', async () => {
    // 200 waiters on a single key stress the waiter-notification code path.
    // The shuffle-on-notify design must not drop waiters.
    const lp = createInMemoryLockProvider();
    const key = 'stress:one-key';
    const N = 200;

    const completed: number[] = [];
    const tasks = Array.from({ length: N }, (_, i) =>
      (async () => {
        await lp.acquire(key, opts(), `inst-${i}`);
        await Promise.resolve();
        completed.push(i);
        await lp.release(key, `inst-${i}`);
      })()
    );

    await Promise.all(tasks);

    assert.strictEqual(completed.length, N, `all ${N} tasks must finish`);
    assert.strictEqual(new Set(completed).size, N, 'each task runs exactly once');
    assert.strictEqual(lp.size, 0);
  });

  it('INVARIANT: acquire/release cycle time stays bounded (no unbounded waiter-set growth)', async () => {
    // If release() leaks waiter-set entries on every cycle, each iteration
    // gets slower. We bound the last 100 cycles to 5x the first 100 PLUS a
    // 50ms absolute slack. At these tiny absolute times (single-digit ms for
    // 100 cycles) the bare ratio is pure timer/GC/scheduler noise on a loaded
    // CI runner — e.g. 1ms->8ms reads as "8x" but isn't growth. The additive
    // floor absorbs that jitter while still catching real O(n^2) blowups,
    // which push `last` into the hundreds of ms.
    const lp = createInMemoryLockProvider();
    const key = 'stress:growth';

    const sampleSize = 100;

    const timeRange = async (start: number, end: number): Promise<number> => {
      const t0 = Date.now();
      for (let i = start; i < end; i++) {
        await lp.acquire(key, opts(), `inst-${i}`);
        await lp.release(key, `inst-${i}`);
      }
      return Date.now() - t0;
    };

    const first = await timeRange(0, sampleSize);
    // Do some more cycles in between.
    await timeRange(sampleSize, sampleSize * 3);
    const last = await timeRange(sampleSize * 3, sampleSize * 3 + sampleSize);

    const bound = first * 5 + 50; // 5x growth + 50ms noise floor
    assert.ok(last < bound,
      `cycle time should not grow unboundedly; first=${first}ms last=${last}ms bound=${bound}ms`);
  });
});
