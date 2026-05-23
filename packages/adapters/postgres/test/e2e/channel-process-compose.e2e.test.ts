/**
 * Channel + process composition - multi-instance pg.
 *
 * The headline use case: a process running on one pod publishes to a
 * channel; a subscriber on ANOTHER pod receives it via pg LISTEN/NOTIFY.
 *
 * This is the simplified shape of the chat-app broadcast flow (room
 * process posts message -> SSE subscriber on another pod sees it), minus
 * the domain specifics.
 *
 * Matrix:
 *   1. Start process on A, signal on B, process publishes to a channel,
 *      subscriber on C receives the published message.
 *   2. The publishing process is the ONLY one that actually handles the
 *      signal - advisory lock de-dupes.
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AbstractProcessExecutor, withExecutor } from '@justscale/core/process';
import postgres from 'postgres';

import { checkPg, createSharedDb, makeInstance, delay, type SharedDb, type InstanceHandle } from './helpers.js';
import { E2eSignals, BroadcastChannels } from './fixtures/e2e-signals.js';
import { publishThroughChannel } from './fixtures/publisher.process.js';

const hasPg = await checkPg();

async function start<T>(app: InstanceHandle, proc: any, params: readonly unknown[]): Promise<{ wait(): Promise<T> }> {
  const executor = await app.app.container.resolve(AbstractProcessExecutor);
  return withExecutor(executor as any, () => proc(params) as any);
}

describe('Channel + process composition (pg)', { skip: !hasPg ? 'docker postgres not reachable' : false }, () => {
  let db: SharedDb;
  let sql: ReturnType<typeof postgres>;
  let a: InstanceHandle;
  let b: InstanceHandle;
  let c: InstanceHandle;

  before(async () => {
    db = await createSharedDb('compose');
    sql = postgres(db.url);
    const signalChannel = `pg_compose_${db.name}`;
    a = await makeInstance({ id: 'a', url: db.url, signalChannel, extra: [E2eSignals, BroadcastChannels] });
    b = await makeInstance({ id: 'b', url: db.url, signalChannel, extra: [E2eSignals, BroadcastChannels] });
    c = await makeInstance({ id: 'c', url: db.url, signalChannel, extra: [E2eSignals, BroadcastChannels] });
  });

  after(async () => {
    await a?.stop();
    await b?.stop();
    await c?.stop();
    await sql?.end();
    await db?.drop();
  });

  it('process on A publishes via channel; subscriber on C receives', async () => {
    const id = `compose-${Date.now()}`;

    // C subscribes.
    const chC = await c.app.container.resolve(BroadcastChannels);
    const sub = chC.subscribe(`pub:${id}`);
    const iter = sub[Symbol.asyncIterator]();

    // Give LISTEN a beat.
    await delay(200);

    // Start the publisher process on A.
    const handle = await start<unknown>(a, publishThroughChannel, [id]);
    await delay(300);

    // Emit publish signal from B - the process on A wakes, publishes,
    // returns.
    const signalsB = await b.app.container.resolve(E2eSignals);
    await signalsB.publish({ id, value: 42 });

    const got = await Promise.race([
      iter.next(),
      delay(4000).then(() => ({ done: true, value: undefined })),
    ]);
    assert.strictEqual(got.done, false, 'C must receive the published message');
    assert.deepStrictEqual(got.value, { value: 42, from: id });

    // Process should also complete cleanly.
    const result = await Promise.race([
      handle.wait(),
      delay(3000).then(() => null),
    ]);
    assert.ok(result, 'process should return after publishing');

    sub.unsubscribe();
  });
});
