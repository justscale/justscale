/**
 * INVARIANT: Cross-instance channel behavior via the Postgres backend.
 *
 * Tests here require a real Postgres. They exercise invariants that ONLY show
 * up with LISTEN/NOTIFY's async delivery path:
 *  - Publish on A, subscribe on B + C: both receive, ordered per-publisher.
 *  - Publish on A after B's connection drop + reconnect: what happens.
 *  - Two-node concurrent publish: subscriber sees a consistent per-publisher
 *    order (NOT necessarily total order).
 *
 * Why a silent failure would hurt:
 *   If cluster pub/sub silently drops a NOTIFY during reconnect, a chat room
 *   freezes until the next message. If ordering flips between instances,
 *   replicated state machines diverge.
 */

import { describe, test, after, before } from 'node:test';
import assert from 'node:assert';
import { PostgresChannelBackend } from '../src/channel/channel-backend.js';
import { requirePostgres, createTestDatabase, type TestDatabase } from './__mocks__/test-setup.js';

describe('PostgresChannelBackend: cross-instance invariants', async () => {
  if (!(await requirePostgres())) return;

  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase('channel_invariants');
  });

  after(async () => {
    await db.drop();
  });

  test('INVARIANT: publish on instance A delivers to subscribers on B and C, in per-publisher FIFO order', async () => {
    const a = new PostgresChannelBackend({ connectionString: db.connectionString });
    const b = new PostgresChannelBackend({ connectionString: db.connectionString });
    const c = new PostgresChannelBackend({ connectionString: db.connectionString });

    const bGot: number[] = [];
    const cGot: number[] = [];

    b.subscribe('cross-k', (msg) => {
      bGot.push((msg as { n: number }).n);
    });
    c.subscribe('cross-k', (msg) => {
      cGot.push((msg as { n: number }).n);
    });

    // Give LISTEN time to register
    await new Promise((r) => setTimeout(r, 250));

    const N = 20;
    for (let i = 0; i < N; i++) a.publish('cross-k', { n: i });

    // Wait for delivery
    const deadline = Date.now() + 3000;
    while ((bGot.length < N || cGot.length < N) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.strictEqual(bGot.length, N, `B got ${bGot.length}/${N}`);
    assert.strictEqual(cGot.length, N, `C got ${cGot.length}/${N}`);
    for (let i = 0; i < N; i++) {
      assert.strictEqual(bGot[i], i, `B out of order at ${i}`);
      assert.strictEqual(cGot[i], i, `C out of order at ${i}`);
    }

    await a.close();
    await b.close();
    await c.close();
  });

  test('INVARIANT: two concurrent publishers on A and B - subscriber on C sees per-publisher monotonic order, no loss, no duplicate', async () => {
    const a = new PostgresChannelBackend({ connectionString: db.connectionString });
    const b = new PostgresChannelBackend({ connectionString: db.connectionString });
    const c = new PostgresChannelBackend({ connectionString: db.connectionString });

    const got: Array<{ tag: 'A' | 'B'; i: number }> = [];
    c.subscribe('concurrent-k', (msg) => {
      got.push(msg as { tag: 'A' | 'B'; i: number });
    });

    await new Promise((r) => setTimeout(r, 250));

    const N = 20;
    // Interleave publishes between two instances
    const aTask = (async () => {
      for (let i = 0; i < N; i++) {
        a.publish('concurrent-k', { tag: 'A', i });
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const bTask = (async () => {
      for (let i = 0; i < N; i++) {
        b.publish('concurrent-k', { tag: 'B', i });
        await new Promise((r) => setTimeout(r, 3));
      }
    })();
    await Promise.all([aTask, bTask]);

    // Wait for delivery settle
    const deadline = Date.now() + 4000;
    while (got.length < 2 * N && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.strictEqual(got.length, 2 * N, `got ${got.length}/${2 * N} (loss likely)`);

    const seen = new Set<string>();
    let lastA = -1;
    let lastB = -1;
    for (const m of got) {
      const k = `${m.tag}:${m.i}`;
      assert.ok(!seen.has(k), `duplicate delivery: ${k}`);
      seen.add(k);
      if (m.tag === 'A') {
        assert.ok(m.i > lastA, `A out of per-publisher order: ${m.i} after ${lastA}`);
        lastA = m.i;
      } else {
        assert.ok(m.i > lastB, `B out of per-publisher order: ${m.i} after ${lastB}`);
        lastB = m.i;
      }
    }
    assert.strictEqual(lastA, N - 1);
    assert.strictEqual(lastB, N - 1);

    await a.close();
    await b.close();
    await c.close();
  });

  test('INVARIANT: subscribing on B after A has already published sees NOTHING from that past publish (no buffering)', async () => {
    // Pin the lossy semantic: Postgres LISTEN/NOTIFY is not durable. A
    // subscriber added after a publish sees nothing.
    const a = new PostgresChannelBackend({ connectionString: db.connectionString });
    const b = new PostgresChannelBackend({ connectionString: db.connectionString });

    // Publish BEFORE B subscribes.
    a.publish('late-k', { n: 1 });

    await new Promise((r) => setTimeout(r, 150));

    const bGot: number[] = [];
    b.subscribe('late-k', (msg) => {
      bGot.push((msg as { n: number }).n);
    });

    await new Promise((r) => setTimeout(r, 250));

    // Now publish - B should see only this.
    a.publish('late-k', { n: 2 });
    await new Promise((r) => setTimeout(r, 400));

    assert.strictEqual(bGot.length, 1, 'B must not see the pre-subscribe publish');
    assert.strictEqual(bGot[0], 2);

    await a.close();
    await b.close();
  });

  test('INVARIANT: a large payload is rejected at publish() with a synchronous throw (>8KB NOTIFY limit)', async () => {
    // Oversize payloads used to vanish into logger.error because
    // PostgresChannelBackend.publish() is fire-and-forget. That silently
    // dropped messages - the caller thought they'd published but the NOTIFY
    // never went. The backend now validates size synchronously and throws,
    // so the caller sees the failure.
    const backend = new PostgresChannelBackend({ connectionString: db.connectionString });
    backend.subscribe('huge-k', () => {});
    await new Promise((r) => setTimeout(r, 150));

    const huge = { big: 'x'.repeat(10_000) };
    assert.throws(
      () => backend.publish('huge-k', huge),
      /too large/i,
      'publish must throw synchronously on oversize payloads, not swallow them',
    );

    await backend.close();
  });

  test('INVARIANT: unsubscribe via Symbol.dispose on one backend instance stops delivery to that instance only', async () => {
    const a = new PostgresChannelBackend({ connectionString: db.connectionString });
    const b = new PostgresChannelBackend({ connectionString: db.connectionString });
    const c = new PostgresChannelBackend({ connectionString: db.connectionString });

    const bGot: number[] = [];
    const cGot: number[] = [];
    const bSub = b.subscribe('iso-k', (msg) => bGot.push((msg as { n: number }).n));
    c.subscribe('iso-k', (msg) => cGot.push((msg as { n: number }).n));

    await new Promise((r) => setTimeout(r, 250));

    a.publish('iso-k', { n: 1 });
    await new Promise((r) => setTimeout(r, 250));
    assert.deepStrictEqual(bGot, [1]);
    assert.deepStrictEqual(cGot, [1]);

    bSub[Symbol.dispose]();
    await new Promise((r) => setTimeout(r, 250));

    a.publish('iso-k', { n: 2 });
    await new Promise((r) => setTimeout(r, 300));

    assert.deepStrictEqual(bGot, [1], 'B must not receive after dispose');
    assert.deepStrictEqual(cGot, [1, 2], 'C must still receive');

    await a.close();
    await b.close();
    await c.close();
  });
});
