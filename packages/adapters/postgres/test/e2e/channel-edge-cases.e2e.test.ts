/**
 * Channel edge cases - multi-instance Postgres.
 *
 * Beyond the baseline fan-out tests in channel-primitive.e2e.test.ts,
 * these probe the rough edges where multi-instance pub/sub tends to
 * leak abstractions: backend tear-down, late joiners, long keys that
 * hit the pg 63-char NOTIFY name limit, Unicode payloads, and clean
 * shutdown semantics.
 *
 * If one of these fails, a production room/chat flow likely has a
 * subtle bug that's invisible under the happy path.
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels, AbstractChannelBackend } from '@justscale/core';
import {
  checkPg,
  createSharedDb,
  makeInstance,
  delay,
  type SharedDb,
  type InstanceHandle,
} from './helpers.js';

const hasPg = await checkPg();

describe('Channel edge cases (pg LISTEN/NOTIFY)', { skip: !hasPg ? 'docker postgres not reachable' : false }, () => {
  const Channels = createChannels<{ n: number; tag?: string }>({ prefix: 'pg-edge:' });

  let db: SharedDb;
  let a: InstanceHandle;
  let b: InstanceHandle;
  let c: InstanceHandle;

  before(async () => {
    db = await createSharedDb('edge');
    const signalChannel = `pg_edge_${db.name}`;
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

  it('late joiner - subscribe after earlier publishes, receive only messages after join (no buffering)', async () => {
    // Pin the lossy semantic: pg LISTEN/NOTIFY is not durable. A subscriber
    // that joins late starts receiving from the moment LISTEN registered.
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    // Pre-existing subscriber so LISTEN is already active on the key.
    const early = chB.subscribe('late-joiner');
    await delay(200);

    // Publish while only B is subscribed.
    chA.publish('late-joiner', { n: 1, tag: 'before' });
    await delay(150);

    // Now C joins.
    const chC = await c.app.container.resolve(Channels);
    const late = chC.subscribe('late-joiner');

    // Give C's LISTEN time to register.
    await delay(300);

    chA.publish('late-joiner', { n: 2, tag: 'after' });

    const deadline = Date.now() + 2000;
    const cReceived: Array<{ n: number; tag?: string }> = [];
    const cIter = late[Symbol.asyncIterator]();
    while (cReceived.length < 1 && Date.now() < deadline) {
      const nx = await Promise.race([
        cIter.next(),
        delay(300).then(() => ({ done: true, value: undefined } as const)),
      ]);
      if (nx.done) break;
      if (nx.value) cReceived.push(nx.value as { n: number; tag?: string });
    }

    assert.deepStrictEqual(cReceived, [{ n: 2, tag: 'after' }], 'late joiner must receive only post-join messages');

    early.unsubscribe();
    late.unsubscribe();
  });

  it('re-subscribe after unsubscribe - same key, same instance, still receives', async () => {
    // If the backend's LISTEN ref-counting is wrong, the second subscribe
    // will silently fail to register and we'll see zero messages.
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    const first = chB.subscribe('resub');
    await delay(150);
    first.unsubscribe();
    await delay(150);

    const second = chB.subscribe('resub');
    await delay(250);

    chA.publish('resub', { n: 42 });

    const iter = second[Symbol.asyncIterator]();
    const got = await Promise.race([
      iter.next(),
      delay(2000).then(() => ({ done: true, value: undefined } as const)),
    ]);
    assert.strictEqual(got.done, false, 'second subscription must still receive');
    assert.deepStrictEqual(got.value, { n: 42 });

    second.unsubscribe();
  });

  it('two subscriptions on same key, same instance - both receive every message exactly once', async () => {
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    const s1 = chB.subscribe('fanout-local');
    const s2 = chB.subscribe('fanout-local');
    await delay(200);

    const N = 5;
    for (let i = 0; i < N; i++) chA.publish('fanout-local', { n: i });

    const drain = async (sub: typeof s1): Promise<number[]> => {
      const got: number[] = [];
      const iter = sub[Symbol.asyncIterator]();
      const deadline = Date.now() + 2000;
      while (got.length < N && Date.now() < deadline) {
        const nx = await Promise.race([
          iter.next(),
          delay(500).then(() => ({ done: true, value: undefined } as const)),
        ]);
        if (nx.done) break;
        if (nx.value) got.push((nx.value as { n: number }).n);
      }
      return got;
    };

    const [g1, g2] = await Promise.all([drain(s1), drain(s2)]);
    assert.deepStrictEqual(g1.sort((x, y) => x - y), [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(g2.sort((x, y) => x - y), [0, 1, 2, 3, 4]);

    s1.unsubscribe();
    s2.unsubscribe();
  });

  it('long channel key (> 63 chars) - auto-hashed by backend, end-to-end delivery still works', async () => {
    // pg LISTEN/NOTIFY channel names cap at 63 chars. The backend hashes
    // oversize names; make sure two instances agree on the hash so a
    // publish on A still routes to a subscriber on B.
    const longKey = 'room-' + 'x'.repeat(200);

    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    const sub = chB.subscribe(longKey);
    await delay(250);

    chA.publish(longKey, { n: 7, tag: 'long' });

    const iter = sub[Symbol.asyncIterator]();
    const got = await Promise.race([
      iter.next(),
      delay(2500).then(() => ({ done: true, value: undefined } as const)),
    ]);
    assert.strictEqual(got.done, false, 'long-key subscription must still route');
    assert.deepStrictEqual(got.value, { n: 7, tag: 'long' });

    sub.unsubscribe();
  });

  it('unicode + emoji payload - roundtrips unchanged cross-instance', async () => {
    // Sanity: pg NOTIFY carries JSON-encoded strings in UTF-8. If the
    // adapter ever swaps encoding, this will break loudly.
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    const Rich = createChannels<{ text: string }>({ prefix: 'pg-edge-rich:' });
    // The test app instances don't have `Rich` registered; use the
    // backend directly via AbstractChannelBackend instead.
    // (Avoids reconfiguring all three instances for a one-off.)
    const backendA = await a.app.container.resolve(AbstractChannelBackend);
    const backendB = await b.app.container.resolve(AbstractChannelBackend);
    void chA; void chB; void Rich;

    const payloads = [
      'hello',
      'привет',
      '日本語',
      'cafe\u0301',
      'emoji test',
    ];

    const got: string[] = [];
    const sub = backendB.subscribe('unicode', (msg) => {
      got.push((msg as { text: string }).text);
    });

    await delay(250);

    for (const text of payloads) {
      backendA.publish('unicode', { text });
    }

    const deadline = Date.now() + 3000;
    while (got.length < payloads.length && Date.now() < deadline) {
      await delay(50);
    }

    assert.deepStrictEqual(got.sort(), [...payloads].sort(), 'unicode payloads must roundtrip unchanged');
    sub[Symbol.dispose]();
  });

  it('two channel defs with different prefixes on the same key - fully isolated', async () => {
    // prefix:foo and otherPrefix:foo must not cross-talk, even though the
    // raw channel key "foo" is the same.
    const Alpha = createChannels<{ n: number }>({ prefix: 'pg-edge-alpha:' });
    const Beta = createChannels<{ n: number }>({ prefix: 'pg-edge-beta:' });

    // Stand up a one-off instance that carries both.
    const signalChannel = `pg_edge_iso_${db.name}`;
    const alpha1 = await makeInstance({ id: 'iso1', url: db.url, signalChannel, extra: [Alpha, Beta] });
    const alpha2 = await makeInstance({ id: 'iso2', url: db.url, signalChannel, extra: [Alpha, Beta] });

    try {
      const chAlpha = await alpha1.app.container.resolve(Alpha);
      const chBeta = await alpha1.app.container.resolve(Beta);
      const peerAlpha = await alpha2.app.container.resolve(Alpha);
      const peerBeta = await alpha2.app.container.resolve(Beta);
      void peerAlpha; void peerBeta;

      const subAlpha = chAlpha.subscribe('shared');
      const subBeta = chBeta.subscribe('shared');
      const alphaIter = subAlpha[Symbol.asyncIterator]();
      const betaIter = subBeta[Symbol.asyncIterator]();

      await delay(250);

      // Publish on Alpha only from the peer instance.
      (await alpha2.app.container.resolve(Alpha)).publish('shared', { n: 100 });

      const gotAlpha = await Promise.race([
        alphaIter.next(),
        delay(1500).then(() => ({ done: true, value: undefined } as const)),
      ]);
      const gotBeta = await Promise.race([
        betaIter.next(),
        delay(400).then(() => ({ done: true, value: undefined } as const)),
      ]);

      assert.strictEqual(gotAlpha.done, false, 'alpha must receive its publish');
      assert.deepStrictEqual(gotAlpha.value, { n: 100 });
      assert.strictEqual(gotBeta.done, true, 'beta must NOT receive alpha publish despite same key');

      subAlpha.unsubscribe();
      subBeta.unsubscribe();
    } finally {
      await alpha1.stop();
      await alpha2.stop();
    }
  });

  it('instance that only publishes (never subscribes) - other instances still receive', async () => {
    // A producer pod must not need a local subscriber to deliver to peers.
    const chA = await a.app.container.resolve(Channels);
    const chC = await c.app.container.resolve(Channels);

    const sub = chC.subscribe('pub-only');
    await delay(250);

    chA.publish('pub-only', { n: 1, tag: 'from-A' });

    const iter = sub[Symbol.asyncIterator]();
    const got = await Promise.race([
      iter.next(),
      delay(2000).then(() => ({ done: true, value: undefined } as const)),
    ]);

    assert.strictEqual(got.done, false);
    assert.deepStrictEqual(got.value, { n: 1, tag: 'from-A' });

    sub.unsubscribe();
  });

  it('stopping an instance ends its local subscriptions - remaining peers keep delivering', async () => {
    // Bring up a throwaway instance to verify: when it stops, the publisher
    // stays live and other subscribers keep receiving.
    const signalChannel = `pg_edge_stop_${db.name}`;
    const ephemeral = await makeInstance({ id: 'eph', url: db.url, signalChannel, extra: [Channels] });

    const chEph = await ephemeral.app.container.resolve(Channels);
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    const sBeforeStop = chB.subscribe('ephemeral-key');
    const sOnEph = chEph.subscribe('ephemeral-key');

    await delay(250);

    chA.publish('ephemeral-key', { n: 1, tag: 'alive' });

    const bIter = sBeforeStop[Symbol.asyncIterator]();
    const ephIter = sOnEph[Symbol.asyncIterator]();
    const firstB = await Promise.race([
      bIter.next(),
      delay(1500).then(() => ({ done: true, value: undefined } as const)),
    ]);
    const firstEph = await Promise.race([
      ephIter.next(),
      delay(1500).then(() => ({ done: true, value: undefined } as const)),
    ]);

    assert.deepStrictEqual(firstB.value, { n: 1, tag: 'alive' });
    assert.deepStrictEqual(firstEph.value, { n: 1, tag: 'alive' });

    // Kill the ephemeral instance.
    await ephemeral.stop();

    // B must keep receiving (A and B are untouched).
    chA.publish('ephemeral-key', { n: 2, tag: 'after-stop' });

    const secondB = await Promise.race([
      bIter.next(),
      delay(2000).then(() => ({ done: true, value: undefined } as const)),
    ]);
    assert.strictEqual(secondB.done, false, 'B must still receive after ephemeral stopped');
    assert.deepStrictEqual(secondB.value, { n: 2, tag: 'after-stop' });

    sBeforeStop.unsubscribe();
  });

  it('LISTEN connection killed mid-subscription - backend reconnects and resumes delivery', async () => {
    // pg-5: if a subscriber's dedicated LISTEN connection is terminated at
    // the pg level (pg_terminate_backend, network blip, pgbouncer restart),
    // the backend should reconnect and re-LISTEN all active channels.
    // postgres.js's listen() has an onclose handler that re-invokes
    // listen(name, fn) for each tracked channel - verify the behaviour.
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    const got: number[] = [];
    const sub = chB.subscribe('reconnect');
    const iter = sub[Symbol.asyncIterator]();
    await delay(300);

    // Warm-up: prove delivery works before the kill.
    chA.publish('reconnect', { n: 1 });
    const first = await Promise.race([
      iter.next(),
      delay(2000).then(() => ({ done: true, value: undefined } as const)),
    ]);
    assert.deepStrictEqual(first.value, { n: 1 });

    // Kill every connection to the test DB. Subscriber's LISTEN conn dies.
    await db.terminateAll();
    // Give the driver a beat to see the close and kick off reconnect.
    await delay(500);

    // Now publish again. If reconnect worked, the subscriber catches it.
    chA.publish('reconnect', { n: 2 });

    const second = await Promise.race([
      iter.next(),
      delay(5000).then(() => ({ done: true, value: undefined } as const)),
    ]);
    assert.strictEqual(second.done, false, 'subscriber must receive post-reconnect publish; postgres.js reconnect path not re-LISTENing');
    assert.deepStrictEqual(second.value, { n: 2 });

    sub.unsubscribe();
  });

  it('unsubscribe mid-flight - messages published after dispose are not delivered', async () => {
    // Race surface: publish -> dispose sequence. After dispose, no messages
    // should reach the disposed subscription, even if a publish was
    // in-flight at the NOTIFY boundary.
    const chA = await a.app.container.resolve(Channels);
    const chB = await b.app.container.resolve(Channels);

    const got: number[] = [];
    const backendB = await b.app.container.resolve(AbstractChannelBackend);

    // Use backend directly so we can install a raw callback and count.
    const sub = backendB.subscribe('pg-edge:midflight', (msg) => {
      got.push((msg as { n: number }).n);
    });

    await delay(250);

    chA.publish('midflight', { n: 1 });
    await delay(150);
    assert.deepStrictEqual(got, [1]);

    sub[Symbol.dispose]();
    // Give the async unlisten a moment.
    await delay(200);

    chA.publish('midflight', { n: 2 });
    await delay(400);

    assert.deepStrictEqual(got, [1], 'no messages should be delivered after dispose');
    void chB;
  });
});
