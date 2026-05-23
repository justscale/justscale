/**
 * Parity spec - shared assertions every ChannelBackend implementation
 * must satisfy.
 *
 * Consumed by:
 * - InMemory parity test (in this package)
 * - Postgres parity test (in packages/adapters/postgres)
 * - Redis parity test (in packages/adapters/redis)
 *
 * If these tests pass for one backend and fail for another, that's a parity
 * bug and justifies a fix in the lagging implementation, NOT a change here.
 *
 * Not a .test.ts file - imported and invoked from real suites.
 *
 * Backend semantics, important to read before adding tests:
 *
 *   ChannelBackend is a TRANSPORT layer. It carries publishes BETWEEN
 *   processes / instances. Local-subscriber fan-out within a single
 *   process is the responsibility of the higher-level Channel class
 *   (see features/channel/channel.ts), NOT the backend.
 *
 *   - MemoryChannelBackend is a no-op transport: same-process subscribers
 *     are NOT served by the backend. Channel handles local delivery itself.
 *   - PostgresChannelBackend / RedisChannelBackend genuinely move messages
 *     over the wire. As a side-effect, a same-process subscriber DOES see
 *     publishes (the wire loops back: NOTIFY -> LISTEN, PUBLISH -> SUBSCRIBE).
 *
 * Therefore "publish-then-receive" tests are gated on `supportsDelivery`
 * (true for pg/redis, false for memory). For memory we only assert the
 * structural contract: subscribe/publish/close don't throw, dispose works.
 *
 * Cross-instance tests are additionally gated on `supportsCrossInstance`
 * (also true for pg/redis, false for memory).
 */

import assert from 'node:assert/strict';
import type { ChannelBackend } from '../../../src/features/channel/backend.js';

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until `predicate()` returns true, polling every 25ms, up to `timeout` ms.
 * Returns the final predicate result.
 */
async function waitFor(
  predicate: () => boolean,
  timeout = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

export interface ChannelParityHarness {
  /**
   * Build a fresh backend instance + a unique key prefix per run.
   * The destroy() must close the backend cleanly so the next run sees no
   * residual subscriptions.
   */
  make(): Promise<{
    backend: ChannelBackend
    keyPrefix: string
    destroy(): Promise<void>
  }>
  /**
   * Build a SECOND backend instance sharing the same underlying transport
   * (same pg database, same redis URL). Used for cross-instance fan-out
   * tests. Only required when `supportsCrossInstance` is true.
   */
  makeSecondInstance?(keyPrefix: string): Promise<{
    backend: ChannelBackend
    destroy(): Promise<void>
  }>
}

export interface ChannelParityTestRegistrar {
  (name: string, fn: () => Promise<void>): void
}

export interface ChannelParityOptions {
  /**
   * Backend actually delivers messages (loops back over the wire to its
   * own subscribers, or transports to other instances). False for the
   * MemoryChannelBackend which is a no-op transport.
   *
   * When false, only the structural-contract tests run.
   */
  supportsDelivery: boolean
  /**
   * Backend can deliver between separate instances on the same channel key.
   * False for memory (local-only); true for pg/redis. Implies
   * supportsDelivery. When false, cross-instance tests are skipped.
   */
  supportsCrossInstance: boolean
  /**
   * Time the backend needs after subscribe() returns before it actually
   * receives messages on the wire. Pg/Redis: ~250ms for LISTEN/SUBSCRIBE
   * to register. Memory: 0.
   */
  subscribeSettleMs?: number
  /**
   * Time to wait after publish() before asserting non-delivery (channel
   * isolation, post-unsubscribe). Pg/Redis: ~200ms.
   */
  nonDeliveryWaitMs?: number
}

/**
 * Register all channel parity tests against a test runner.
 *
 * @example
 *   describe('ChannelBackend parity - InMemory', () => {
 *     registerChannelParityTests(it, harness, {
 *       supportsDelivery: false, supportsCrossInstance: false,
 *     });
 *   });
 */
export function registerChannelParityTests(
  register: ChannelParityTestRegistrar,
  harness: ChannelParityHarness,
  options: ChannelParityOptions,
): void {
  const SETTLE = options.subscribeSettleMs ?? 0;
  const NON_DELIVERY = options.nonDeliveryWaitMs ?? 5;

  async function settle(): Promise<void> {
    if (SETTLE > 0) await delay(SETTLE);
  }

  // =========================================================================
  // Structural contract - applies to every backend, including memory no-op.
  // =========================================================================

  register('PARITY: subscribe returns a Disposable; dispose does not throw', async () => {
    const { backend, keyPrefix, destroy } = await harness.make();
    try {
      const sub = backend.subscribe(`${keyPrefix}struct`, () => {});
      assert.strictEqual(typeof sub[Symbol.dispose], 'function',
        'subscribe must return a Disposable');
      assert.doesNotThrow(() => sub[Symbol.dispose]());
      assert.doesNotThrow(() => sub[Symbol.dispose](),
        'double-dispose must be idempotent');
    } finally {
      await destroy();
    }
  });

  register('PARITY: publish without subscribers does not throw', async () => {
    const { backend, keyPrefix, destroy } = await harness.make();
    try {
      assert.doesNotThrow(() => backend.publish(`${keyPrefix}orphan`, { x: 1 }));
    } finally {
      await destroy();
    }
  });

  register('PARITY: close() resolves; double close is idempotent', async () => {
    const { backend, destroy } = await harness.make();
    try {
      await assert.doesNotReject(backend.close());
      await assert.doesNotReject(backend.close(),
        'second close() must not reject');
    } finally {
      await destroy();
    }
  });

  // =========================================================================
  // Delivery semantics - skipped on memory backend (no-op transport).
  // Pg / Redis carry messages over the wire and loop back to local
  // subscribers, so we can assert delivery using a single backend instance.
  // =========================================================================

  if (options.supportsDelivery) {
    // -----------------------------------------------------------------------
    // 5. Multi-subscriber fan-out on one instance.
    // -----------------------------------------------------------------------
    register('PARITY: 5 subscribers on same key all receive a single publish', async () => {
      const { backend, keyPrefix, destroy } = await harness.make();
      try {
        const key = `${keyPrefix}fan`;
        const counts = [0, 0, 0, 0, 0];
        const disposers: Disposable[] = [];
        for (let i = 0; i < 5; i++) {
          disposers.push(backend.subscribe(key, () => { counts[i]++; }));
        }
        await settle();

        backend.publish(key, { hello: 'world' });

        const ok = await waitFor(() => counts.every((c) => c >= 1));
        assert.ok(ok, `expected all 5 to receive 1, got ${JSON.stringify(counts)}`);

        for (const d of disposers) d[Symbol.dispose]();
      } finally {
        await destroy();
      }
    });

    // -----------------------------------------------------------------------
    // 8. Channel key isolation.
    // -----------------------------------------------------------------------
    register('PARITY: publish on chanA does not leak to chanB subscriber', async () => {
      const { backend, keyPrefix, destroy } = await harness.make();
      try {
        const a = `${keyPrefix}A`;
        const b = `${keyPrefix}B`;
        const aGot: unknown[] = [];
        const bGot: unknown[] = [];
        const da = backend.subscribe(a, (m) => aGot.push(m));
        const db = backend.subscribe(b, (m) => bGot.push(m));
        await settle();

        backend.publish(a, { which: 'a' });

        await waitFor(() => aGot.length >= 1);
        await delay(NON_DELIVERY);

        assert.strictEqual(aGot.length, 1);
        assert.strictEqual(bGot.length, 0,
          'channel B must not receive A traffic');

        da[Symbol.dispose]();
        db[Symbol.dispose]();
      } finally {
        await destroy();
      }
    });

    // -----------------------------------------------------------------------
    // 9. Empty / undefined payloads must reach the subscriber.
    //    Pins serialization edge: backends that JSON.stringify(undefined)
    //    get the literal string "undefined" (not valid JSON). Some backends
    //    silently drop those; the contract says they must be delivered.
    // -----------------------------------------------------------------------
    register('PARITY: undefined and {} payloads both reach subscribers without throwing', async () => {
      const { backend, keyPrefix, destroy } = await harness.make();
      try {
        const key = `${keyPrefix}empty`;
        const got: unknown[] = [];
        const sub = backend.subscribe(key, (m) => got.push(m));
        await settle();

        // These must not throw synchronously.
        backend.publish(key, undefined);
        backend.publish(key, {});

        const ok = await waitFor(() => got.length >= 2);
        assert.ok(ok, `expected 2 messages for undefined+{}, got ${got.length}`);

        sub[Symbol.dispose]();
      } finally {
        await destroy();
      }
    });

    // -----------------------------------------------------------------------
    // 3. Identical payloads are NOT deduplicated.
    //    Direct regression for the Set->Map fix at the channel layer.
    //    Backend layer also must not dedup.
    // -----------------------------------------------------------------------
    register('PARITY: 3 identical publishes deliver 3 messages (no dedup)', async () => {
      const { backend, keyPrefix, destroy } = await harness.make();
      try {
        const key = `${keyPrefix}dedup`;
        const got: unknown[] = [];
        const sub = backend.subscribe(key, (m) => got.push(m));
        await settle();

        backend.publish(key, { n: 1 });
        backend.publish(key, { n: 1 });
        backend.publish(key, { n: 1 });

        const ok = await waitFor(() => got.length >= 3);
        assert.ok(ok, `identical payloads must not be deduped, got ${got.length}`);

        // No spurious 4th later.
        await delay(NON_DELIVERY);
        assert.strictEqual(got.length, 3);

        sub[Symbol.dispose]();
      } finally {
        await destroy();
      }
    });

    // -----------------------------------------------------------------------
    // 10. 100 concurrent publishes from one publisher in call order.
    //     Catches batching / reordering bugs.
    // -----------------------------------------------------------------------
    register('PARITY: 100 concurrent publishes from one publisher arrive in call order', async () => {
      const { backend, keyPrefix, destroy } = await harness.make();
      try {
        const key = `${keyPrefix}burst`;
        const got: number[] = [];
        const sub = backend.subscribe(key, (m) => {
          got.push((m as { i: number }).i);
        });
        await settle();

        const N = 100;
        const tasks = Array.from({ length: N }, (_, i) =>
          Promise.resolve().then(() => backend.publish(key, { i })),
        );
        await Promise.all(tasks);

        const ok = await waitFor(() => got.length >= N, 5_000);
        assert.ok(ok, `expected ${N} messages, got ${got.length}`);

        for (let i = 0; i < N; i++) {
          assert.strictEqual(got[i], i,
            `out of order at index ${i}: got ${got[i]}`);
        }

        sub[Symbol.dispose]();
      } finally {
        await destroy();
      }
    });

    // -----------------------------------------------------------------------
    // 4. Subscribe -> dispose -> subscribe-same-key cycle.
    //    Catches "second subscribe sees nothing because backend marked the
    //    channel as torn down".
    // -----------------------------------------------------------------------
    register('PARITY: dispose then re-subscribe same key still receives subsequent publishes', async () => {
      const { backend, keyPrefix, destroy } = await harness.make();
      try {
        const key = `${keyPrefix}cycle`;
        const got1: number[] = [];
        const sub1 = backend.subscribe(key, (m) => got1.push((m as { n: number }).n));
        await settle();

        backend.publish(key, { n: 1 });
        const ok1 = await waitFor(() => got1.length >= 1);
        assert.ok(ok1, 'first subscriber should get the first publish');

        sub1[Symbol.dispose]();
        // Backend needs time to actually unsubscribe from the wire.
        await delay(NON_DELIVERY);

        const got2: number[] = [];
        const sub2 = backend.subscribe(key, (m) => got2.push((m as { n: number }).n));
        await settle();

        backend.publish(key, { n: 2 });

        const ok2 = await waitFor(() => got2.length >= 1);
        assert.ok(ok2, 're-subscribe must receive subsequent publishes');
        assert.strictEqual(got2[0], 2);

        sub2[Symbol.dispose]();
      } finally {
        await destroy();
      }
    });

    // -----------------------------------------------------------------------
    // 7. close() while subscribed: no throw, no further deliveries.
    // -----------------------------------------------------------------------
    register('PARITY: close() while subscribed does not throw and stops delivery', async () => {
      const { backend, keyPrefix, destroy } = await harness.make();
      try {
        const key = `${keyPrefix}close`;
        const got: unknown[] = [];
        backend.subscribe(key, (m) => got.push(m));
        await settle();

        await assert.doesNotReject(backend.close());

        // publish after close: no crash, no delivery.
        try {
          backend.publish(key, { post: 'close' });
        } catch {
          // Throwing cleanly is acceptable per the contract.
        }

        await delay(NON_DELIVERY);
        assert.strictEqual(got.length, 0, 'no messages after close()');
      } finally {
        try { await destroy(); } catch { /* */ }
      }
    });

    // -----------------------------------------------------------------------
    // 2. Pre-subscribe publishes are dropped, NOT queued.
    // -----------------------------------------------------------------------
    register('PARITY: pre-subscribe publishes are dropped (no replay)', async () => {
      const { backend, keyPrefix, destroy } = await harness.make();
      try {
        const key = `${keyPrefix}noreplay`;

        for (let i = 0; i < 5; i++) {
          try { backend.publish(key, { i, phase: 'pre' }); } catch { /* */ }
        }
        await delay(NON_DELIVERY);

        const got: Array<{ i: number; phase: string }> = [];
        const sub = backend.subscribe(key, (m) => {
          got.push(m as { i: number; phase: string });
        });
        await settle();

        backend.publish(key, { i: 99, phase: 'post' });
        const ok = await waitFor(() => got.some((m) => m.phase === 'post'));
        assert.ok(ok, 'sentinel must arrive');

        const preCount = got.filter((m) => m.phase === 'pre').length;
        assert.strictEqual(preCount, 0,
          `expected 0 replayed pre-subscribe messages, saw ${preCount}`);

        sub[Symbol.dispose]();
      } finally {
        await destroy();
      }
    });
  }

  // =========================================================================
  // Cross-instance tests - only for backends that span processes.
  // =========================================================================

  if (options.supportsCrossInstance && harness.makeSecondInstance) {
    // -----------------------------------------------------------------------
    // 6. Multi-INSTANCE fan-out.
    // -----------------------------------------------------------------------
    register('PARITY (cross-instance): publish on A delivers to subscriber on B', async () => {
      const { backend: a, keyPrefix, destroy: destroyA } = await harness.make();
      const { backend: b, destroy: destroyB } = await harness.makeSecondInstance!(keyPrefix);
      try {
        const key = `${keyPrefix}xi-fan`;
        const bGot: unknown[] = [];
        b.subscribe(key, (m) => bGot.push(m));
        await settle();
        await settle(); // double-settle for cross-instance

        a.publish(key, { from: 'A' });

        const ok = await waitFor(() => bGot.length >= 1, 5_000);
        assert.ok(ok, `B did not receive cross-instance publish; got ${bGot.length}`);
        assert.deepStrictEqual(bGot[0], { from: 'A' });
      } finally {
        await destroyA();
        await destroyB();
      }
    });

    // -----------------------------------------------------------------------
    // 1. Per-publisher monotonic order across two instances, 50 each.
    //    Direct regression for the per-publisher FIFO invariant. Both
    //    instances also share a third instance C as the subscriber, so
    //    we don't conflate self-loopback with cross-instance routing.
    // -----------------------------------------------------------------------
    register('PARITY (cross-instance): two publishers x 50 interleaved - per-publisher order preserved', async () => {
      const { backend: a, keyPrefix, destroy: destroyA } = await harness.make();
      const { backend: b, destroy: destroyB } = await harness.makeSecondInstance!(keyPrefix);
      const { backend: c, destroy: destroyC } = await harness.makeSecondInstance!(keyPrefix);
      try {
        const key = `${keyPrefix}xi-order`;
        const got: Array<{ tag: 'A' | 'B'; i: number }> = [];
        c.subscribe(key, (m) => got.push(m as { tag: 'A' | 'B'; i: number }));
        await settle();
        await settle();

        const N = 50;
        const aTask = (async () => {
          for (let i = 0; i < N; i++) {
            a.publish(key, { tag: 'A', i });
            if (i % 5 === 0) await delay(1);
          }
        })();
        const bTask = (async () => {
          for (let i = 0; i < N; i++) {
            b.publish(key, { tag: 'B', i });
            if (i % 5 === 0) await delay(1);
          }
        })();
        await Promise.all([aTask, bTask]);

        const ok = await waitFor(() => got.length >= 2 * N, 8_000);
        assert.ok(ok, `expected ${2 * N} messages, got ${got.length}`);

        const seen = new Set<string>();
        let lastA = -1;
        let lastB = -1;
        for (let idx = 0; idx < got.length; idx++) {
          const m = got[idx];
          const k = `${m.tag}:${m.i}`;
          assert.ok(!seen.has(k), `duplicate delivery: ${k}`);
          seen.add(k);
          if (m.tag === 'A') {
            assert.ok(m.i > lastA,
              `A out of per-publisher order at received idx ${idx}: ${m.i} after ${lastA}`);
            lastA = m.i;
          } else {
            assert.ok(m.i > lastB,
              `B out of per-publisher order at received idx ${idx}: ${m.i} after ${lastB}`);
            lastB = m.i;
          }
        }
        assert.strictEqual(lastA, N - 1, 'all of A received');
        assert.strictEqual(lastB, N - 1, 'all of B received');
      } finally {
        await destroyA();
        await destroyB();
        await destroyC();
      }
    });

    // -----------------------------------------------------------------------
    // 6b. Cross-instance no-replay: B subscribes after A publishes;
    //     that publish must NOT arrive.
    // -----------------------------------------------------------------------
    register('PARITY (cross-instance): publishes before B subscribes are not buffered', async () => {
      const { backend: a, keyPrefix, destroy: destroyA } = await harness.make();
      const { backend: b, destroy: destroyB } = await harness.makeSecondInstance!(keyPrefix);
      try {
        const key = `${keyPrefix}xi-noreplay`;

        a.publish(key, { phase: 'pre' });
        await delay(NON_DELIVERY);

        const bGot: Array<{ phase: string }> = [];
        b.subscribe(key, (m) => bGot.push(m as { phase: string }));
        await settle();
        await settle();

        a.publish(key, { phase: 'post' });
        const ok = await waitFor(() => bGot.some((m) => m.phase === 'post'));
        assert.ok(ok, 'sentinel must arrive');

        const preCount = bGot.filter((m) => m.phase === 'pre').length;
        assert.strictEqual(preCount, 0,
          `cross-instance backend must not buffer pre-subscribe publishes; saw ${preCount}`);
      } finally {
        await destroyA();
        await destroyB();
      }
    });
  }
}
