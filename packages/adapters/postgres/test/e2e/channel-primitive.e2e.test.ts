/**
 * Channel primitive - multi-instance Postgres conformance.
 *
 * Covers the PostgresChannelBackend + createChannels wiring against a real
 * Postgres LISTEN/NOTIFY connection from multiple in-process JustScale apps.
 *
 * Matrix:
 *   1. Publish on A, subscribe on B -> B receives.
 *   2. Three instances, publish on any, subscribe on all -> all receive.
 *   3. Two keys on the same DB -> no cross-talk.
 *   4. Backpressure: publisher faster than consumer -> all messages buffered.
 *   5. Subscribe before publish - deferred LISTEN still catches the publish.
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels, AbstractChannelBackend } from '@justscale/core';
import { createSharedDb, makeInstance, checkPg, delay, type SharedDb, type InstanceHandle } from './helpers.js';

const hasPg = await checkPg();

describe('Channel primitive (pg LISTEN/NOTIFY)', { skip: !hasPg ? 'docker postgres not reachable' : false }, () => {
  let db: SharedDb;
  let a: InstanceHandle;
  let b: InstanceHandle;
  let c: InstanceHandle;

  // A module-scoped channel def - same key space across instances.
  const Channels = createChannels<{ seq: number; from: string }>({ prefix: 'pg-e2e-chan:' });

  before(async () => {
    db = await createSharedDb('channel');
    const signalChannel = `pg_chan_${db.name}`;
    a = await makeInstance({ id: 'a', url: db.url, signalChannel, extra: [Channels] });
    b = await makeInstance({ id: 'b', url: db.url, signalChannel, extra: [Channels] });
    c = await makeInstance({ id: 'c', url: db.url, signalChannel, extra: [Channels] });
  });

  after(async () => {
    await a?.stop();
    await b?.stop();
    await c?.stop();
    await db?.drop();
  });

  it('publish on A, subscribe on B -> B receives', async () => {
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    const sub = chB.subscribe('room-1');
    const iter = sub[Symbol.asyncIterator]();

    // Wait for the LISTEN ACK on B before A publishes.
    await sub.ready;

    chA.publish('room-1', { seq: 1, from: 'A' });

    const got = await Promise.race([
      iter.next(),
      delay(3000).then(() => ({ done: true, value: undefined })),
    ]);
    assert.strictEqual(got.done, false, 'B should receive something within 3s');
    assert.deepStrictEqual(got.value, { seq: 1, from: 'A' });

    sub.unsubscribe();
  });

  it('three instances - publish on any, subscribe on all -> all receive', async () => {
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);
    const chC = await c.app.container.resolve(Channels);

    const subA = chA.subscribe('broadcast-1');
    const subB = chB.subscribe('broadcast-1');
    const subC = chC.subscribe('broadcast-1');

    const firsts = [subA, subB, subC].map(s => s[Symbol.asyncIterator]().next());

    await Promise.all([subA.ready, subB.ready, subC.ready]);

    chB.publish('broadcast-1', { seq: 7, from: 'B' });

    const results = await Promise.all(firsts.map(p =>
      Promise.race([p, delay(3000).then(() => ({ done: true, value: undefined }))]),
    ));

    for (const [i, r] of results.entries()) {
      assert.strictEqual(r.done, false, `instance ${'abc'[i]} should receive; got done=${r.done}`);
      assert.deepStrictEqual(r.value, { seq: 7, from: 'B' });
    }

    subA.unsubscribe();
    subB.unsubscribe();
    subC.unsubscribe();
  });

  it('two channel keys on same DB -> no cross-talk', async () => {
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    const subRedOnB = chB.subscribe('topic-red');
    const subBlueOnB = chB.subscribe('topic-blue');
    const redIter = subRedOnB[Symbol.asyncIterator]();
    const blueIter = subBlueOnB[Symbol.asyncIterator]();

    await Promise.all([subRedOnB.ready, subBlueOnB.ready]);

    chA.publish('topic-red', { seq: 1, from: 'A' });

    // Red should fire, blue should NOT within a small window.
    const red = await Promise.race([
      redIter.next(),
      delay(2000).then(() => ({ done: true, value: undefined })),
    ]);
    const blue = await Promise.race([
      blueIter.next(),
      delay(400).then(() => ({ done: true, value: undefined })),
    ]);

    assert.strictEqual(red.done, false);
    assert.deepStrictEqual(red.value, { seq: 1, from: 'A' });
    assert.strictEqual(blue.done, true, 'blue channel should not receive red publishes');

    subRedOnB.unsubscribe();
    subBlueOnB.unsubscribe();
  });

  it('backpressure - publisher faster than consumer -> messages buffer, none dropped', async () => {
    // We assume the channel backend buffers per-subscription. If this test
    // fails, the framework docs say otherwise - update the assertion.
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    const sub = chB.subscribe('burst-1');

    await sub.ready;

    const N = 50;
    for (let i = 0; i < N; i++) chA.publish('burst-1', { seq: i, from: 'A' });

    // Drain with generous but finite budget.
    const received: Array<{ seq: number }> = [];
    const deadline = Date.now() + 5000;
    const iter = sub[Symbol.asyncIterator]();
    while (received.length < N && Date.now() < deadline) {
      const next = await Promise.race([
        iter.next(),
        delay(500).then(() => ({ done: true, value: undefined })),
      ]);
      if (next.done) break;
      if (next.value) received.push(next.value as { seq: number });
    }

    // Per-subscription buffering contract: every publish lands. Order may
    // vary because pg NOTIFY within a tx batches - but with simple single
    // publishes the driver preserves order.
    assert.strictEqual(received.length, N, `expected ${N}, got ${received.length}`);
    const seqs = received.map(r => r.seq).sort((x, y) => x - y);
    for (let i = 0; i < N; i++) assert.strictEqual(seqs[i], i);

    sub.unsubscribe();
  });

  it('subscribe on A, publish on A - local delivery still works via backend loopback', async () => {
    // With a real backend the channel delivers both locally AND via NOTIFY.
    const chA = await a.app.container.resolve(Channels);
    const sub = chA.subscribe('self-loop');
    const iter = sub[Symbol.asyncIterator]();

    await sub.ready;

    chA.publish('self-loop', { seq: 1, from: 'A' });

    const got = await Promise.race([
      iter.next(),
      delay(2000).then(() => ({ done: true, value: undefined })),
    ]);
    assert.strictEqual(got.done, false);
    assert.deepStrictEqual(got.value, { seq: 1, from: 'A' });

    sub.unsubscribe();
  });

  it('channel backend is the pg-backed one (sanity)', async () => {
    const backendA = await a.app.container.resolve(AbstractChannelBackend);
    const backendB = await b.app.container.resolve(AbstractChannelBackend);
    // Both resolve through the pg feature - class name sanity check keeps
    // us honest that PostgresChannelFeature really bound this service.
    assert.strictEqual(backendA.constructor.name, 'PostgresChannelBackend');
    assert.strictEqual(backendB.constructor.name, 'PostgresChannelBackend');
    // And they should be DIFFERENT instances (separate pools per app).
    assert.notStrictEqual(backendA, backendB, 'each app must own its pg connection');
  });
});
