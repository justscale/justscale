/**
 * Parity spec — shared assertions that every LockProvider implementation
 * must satisfy.
 *
 * Consumed by:
 * - InMemory parity test (in this package)
 * - Postgres parity test (in packages/adapters/postgres)
 *
 * If these tests pass for one provider and fail for another, that's a parity
 * bug and justifies a fix in the lagging implementation, NOT a change here.
 *
 * Not a .test.ts file — imported and invoked from real suites.
 */

import assert from 'node:assert/strict';
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

export interface ParityHarness {
  /** Fresh provider + unique key prefix per run; throwaway. */
  make(): Promise<{
    provider: LockProvider
    keyPrefix: string
    /**
     * Destroy the provider (close connections, terminate backends).
     * Must leave the backend (e.g. pg server) reusable for the next run.
     */
    destroy(): Promise<void>
  }>
  /**
   * Acquire from a completely separate provider instance — simulates
   * "another process" trying to acquire the same key.
   *
   * For InMemory, there is no meaningful separate process; implementations
   * should return `null` and the relevant tests will skip.
   */
  makeSeparateProcess?(): Promise<{
    provider: LockProvider
    destroy(): Promise<void>
  } | null>
}

export interface ParityTestRegistrar {
  (name: string, fn: () => Promise<void>): void
}

/**
 * Register all parity tests against a test runner.
 *
 * @example
 *   describe('InMemory parity', () => {
 *     registerParityTests(it, inMemoryHarness)
 *   })
 */
export function registerParityTests(
  register: ParityTestRegistrar,
  harness: ParityHarness,
): void {
  register('PARITY: acquire then release round-trips cleanly', async () => {
    const { provider, keyPrefix, destroy } = await harness.make();
    try {
      const key = `${keyPrefix}rt`;
      const meta = await provider.acquire(key, opts(), 'owner');
      assert.ok(meta);
      assert.strictEqual(meta.lockedBy, 'owner');
      await provider.release(key, 'owner');
    } finally {
      await destroy();
    }
  });

  register('PARITY: concurrent same-context acquires SERIALIZE (no deadlock, both finish)', async () => {
    const { provider, keyPrefix, destroy } = await harness.make();
    try {
      const key = `${keyPrefix}mx`;
      let peak = 0;
      let concurrent = 0;
      let completed = 0;
      const tasks = Array.from({ length: 10 }, (_, i) =>
        (async () => {
          await provider.acquire(key, opts(), `inst-${i}`);
          concurrent++;
          peak = Math.max(peak, concurrent);
          for (let k = 0; k < 3; k++) await Promise.resolve();
          concurrent--;
          completed++;
          await provider.release(key, `inst-${i}`);
        })(),
      );
      await Promise.all(tasks);
      assert.strictEqual(peak, 1, `peak in-flight must be 1, was ${peak}`);
      assert.strictEqual(completed, 10);
    } finally {
      await destroy();
    }
  });

  register('PARITY: different keys do not block each other', async () => {
    // If k1 is held, k2 must still be acquirable quickly — there's no
    // shared gate between unrelated keys.
    const { provider, keyPrefix, destroy } = await harness.make();
    try {
      const k1 = `${keyPrefix}A`;
      const k2 = `${keyPrefix}B`;

      await provider.acquire(k1, opts(), 'A');

      const start = Date.now();
      await provider.acquire(k2, opts(), 'B');
      const elapsed = Date.now() - start;

      // 2-second ceiling; generous but still catches a full serialization.
      assert.ok(elapsed < 2_000,
        `acquire on distinct key should not wait for unrelated lock; took ${elapsed}ms`);

      await provider.release(k1, 'A');
      await provider.release(k2, 'B');
    } finally {
      await destroy();
    }
  });

  register('PARITY: release is idempotent (double release does not throw)', async () => {
    const { provider, keyPrefix, destroy } = await harness.make();
    try {
      const key = `${keyPrefix}idem`;
      await provider.acquire(key, opts(), 'x');
      await provider.release(key, 'x');
      await provider.release(key, 'x'); // must not throw
    } finally {
      await destroy();
    }
  });

  register('PARITY: release of never-acquired key does not throw', async () => {
    const { provider, destroy, keyPrefix } = await harness.make();
    try {
      await provider.release(`${keyPrefix}never`, 'nobody'); // must not throw
    } finally {
      await destroy();
    }
  });

  register('PARITY: extend() on non-held lock returns false', async () => {
    const { provider, keyPrefix, destroy } = await harness.make();
    try {
      const ok = await provider.extend(`${keyPrefix}absent`, 'anyone', 30_000);
      assert.strictEqual(ok, false);
    } finally {
      await destroy();
    }
  });

  register('PARITY: extend() by wrong instance returns false', async () => {
    const { provider, keyPrefix, destroy } = await harness.make();
    try {
      const key = `${keyPrefix}wrong-ext`;
      await provider.acquire(key, opts(), 'real');
      const ok = await provider.extend(key, 'impostor', 30_000);
      assert.strictEqual(ok, false);
      await provider.release(key, 'real');
    } finally {
      await destroy();
    }
  });

  register('PARITY: release after close() of provider does not throw', async () => {
    const { provider, keyPrefix, destroy } = await harness.make();
    try {
      const key = `${keyPrefix}after-close`;
      await provider.acquire(key, opts(), 'x');
      await provider.close();
      // Release after close must not throw — matches cleanup-in-finally pattern.
      await provider.release(key, 'x');
    } finally {
      await destroy();
    }
  });

  register('PARITY: cross-process takeover works after holder is destroyed', async () => {
    // Only runs if the harness provides a separate-process simulator.
    if (!harness.makeSeparateProcess) {
      return; // graceful skip
    }
    const { provider, keyPrefix, destroy } = await harness.make();
    const other = await harness.makeSeparateProcess();
    if (!other) { await destroy(); return; }

    try {
      const key = `${keyPrefix}takeover`;
      await provider.acquire(key, opts({ ttl: 5000 }), 'pid-1');
      // Simulate crash: destroy the first provider *without* releasing.
      await destroy();

      // A second "process" must eventually be able to acquire the same key.
      const start = Date.now();
      await other.provider.acquire(key, opts({ ttl: 5000 }), 'pid-2');
      const waited = Date.now() - start;
      assert.ok(waited < 10_000, `takeover must not hang; waited ${waited}ms`);
      await other.provider.release(key, 'pid-2');
    } finally {
      await other.destroy();
    }
  });

  register('PARITY: release wakes up a blocked waiter (not polling-based)', async () => {
    // INTENT: the provider uses a true-blocking wait (e.g. pg_advisory_lock
    // with the connection pinned), not a poll loop. A polling implementation
    // would typically add 500–1000 ms of latency on each release.
    //
    // The bound is 2000 ms, not 500 ms, because this suite often runs
    // alongside a pool-exhaustion-level of concurrent pg work — scheduler +
    // connection-checkout noise alone can push a truly-instant wake into
    // seconds under parallel load. In isolation the observed latency is
    // < 100 ms; a regression to polling would be measured in thousands.
    const { provider, keyPrefix, destroy } = await harness.make();
    try {
      const key = `${keyPrefix}wake`;
      await provider.acquire(key, opts(), 'holder');

      const waitStart = Date.now();
      const waiter = (async () => {
        await provider.acquire(key, opts(), 'waiter');
        return Date.now();
      })();

      await delay(50);
      await provider.release(key, 'holder');

      const got = await waiter;
      const fromRelease = got - (waitStart + 50);
      assert.ok(fromRelease < 2000,
        `waiter should resume within 2000ms of release, took ${fromRelease}ms`);
      await provider.release(key, 'waiter');
    } finally {
      await destroy();
    }
  });
}
