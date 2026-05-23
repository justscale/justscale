/**
 * Subscription-table hygiene probes for the pg signal bus.
 *
 * The PgSignalBus INSERTs a new `process_signal_subscriptions` row for
 * every subscribe() / subscribeRace() call. Rows are deleted when the
 * executor that owns the subscription calls `unsubscribe(subId)` after
 * handling a match. That cleanup path lives in the executor's in-memory
 * `this.subscriptions` map - which does NOT survive an instance crash.
 *
 * These probes measure:
 *   1. Normal life-cycle: no orphans after a process completes cleanly.
 *   2. Rapid emit: queued-payload path delivers every signal even when
 *      emits arrive faster than the process re-subscribes.
 *   3. Crash + failover: subscription rows written by the crashed instance
 *      are cleaned up by the new owner before it inserts its own - was
 *      previously leaking; fixed by deleting stale rows in subscribe() /
 *      subscribeRace() before INSERT.
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { AbstractProcessExecutor, withExecutor } from '@justscale/core/process';

import { checkPg, createSharedDb, makeInstance, delay, waitFor, type SharedDb, type InstanceHandle } from './helpers.js';
import { E2eSignals } from './fixtures/e2e-signals.js';
import { signalLoop } from './fixtures/e2e-processes.process.js';

const hasPg = await checkPg();

interface ProcHandle<T> { wait(): Promise<T> }
async function startProcess<T>(
  app: InstanceHandle,
  proc: any,
  params: readonly unknown[],
): Promise<ProcHandle<T>> {
  const executor = await app.app.container.resolve(AbstractProcessExecutor);
  return withExecutor(executor as any, () => proc(params) as any);
}

describe('PG signal-bus subscription hygiene', { skip: !hasPg ? 'docker postgres not reachable' : false }, () => {
  let db: SharedDb;
  let sql: ReturnType<typeof postgres>;

  before(async () => {
    db = await createSharedDb('subleaks');
    sql = postgres(db.url);
  });

  after(async () => {
    await sql?.end();
    await db?.drop();
  });

  // --------------------------------------------------------------------------
  // 1. Happy path: normal completion leaves no waiting/matched rows for this id.
  // --------------------------------------------------------------------------

  it('after a signalLoop completes cleanly, zero subscriptions remain for that instance', async () => {
    const signalChannel = `pg_subleak_${db.name}_a`;
    const a = await makeInstance({ id: 'a', url: db.url, signalChannel, extra: [E2eSignals] });
    try {
      const id = `hygiene-${Date.now()}`;
      const signals = await a.app.container.resolve(E2eSignals);
      const handle = await startProcess<{ id: string; count: number; timedOut: boolean }>(a, signalLoop, [id]);

      // Fire 5 signals, spaced out enough that the process re-subscribes between.
      for (let i = 0; i < 5; i++) {
        await signals.go({ id });
        await delay(400);
      }

      const result = await Promise.race([
        handle.wait(),
        delay(3000).then(() => null),
      ]);
      const [row] = await sql<{ pc: number; status: string; variables: any }[]>`SELECT pc, status, variables FROM process_executions WHERE instance_id = ${`e2e-loop/${id}`}`;
      const subs = await sql<{ status: string }[]>`SELECT status FROM process_signal_subscriptions WHERE instance_id = ${`e2e-loop/${id}`}`;
      assert.ok(result, `process did not complete within 3s; row=${JSON.stringify({ pc: row?.pc, status: row?.status, vars: row?.variables })}; subs=${JSON.stringify(subs)}`);
      assert.strictEqual(result!.count, 5, `expected count=5, got ${result!.count}; row=${JSON.stringify(row)}`);
      assert.strictEqual(result!.timedOut, false);

      // All subscriptions for this instanceId should be gone.
      const [{ count }] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM process_signal_subscriptions
        WHERE instance_id = ${`e2e-loop/${id}`}`;
      assert.strictEqual(
        Number(count),
        0,
        `expected 0 remaining subscriptions, got ${count} - normal-path cleanup is leaking`,
      );
    } finally {
      await a.stop();
    }
  });

  // --------------------------------------------------------------------------
  // 2. Rapid emit: the queued-payloads path must deliver every signal.
  // --------------------------------------------------------------------------

  it('rapid emits (faster than re-subscribe) still deliver all signals via queuedPayloads', async () => {
    const signalChannel = `pg_subleak_${db.name}_b`;
    const a = await makeInstance({ id: 'a', url: db.url, signalChannel, extra: [E2eSignals] });
    try {
      const id = `rapid-${Date.now()}`;
      const signals = await a.app.container.resolve(E2eSignals);
      const handle = await startProcess<{ id: string; count: number; timedOut: boolean }>(a, signalLoop, [id]);

      // Give the process a beat to land at its first race().
      await delay(100);

      // Burst: fire all 5 signals without waiting between. Most will land
      // while the process is between subscriptions - they should be queued
      // on the matched subscription and picked up by the next subscribeRace.
      await Promise.all(Array.from({ length: 5 }, () => signals.go({ id })));

      const result = await Promise.race([
        handle.wait(),
        delay(5000).then(() => null),
      ]);

      assert.ok(result, 'process should complete within 5s');
      assert.strictEqual(result!.count, 5, `expected count=5 after burst; got ${result!.count}. Queued-payload path may be dropping signals.`);
      assert.strictEqual(result!.timedOut, false);
    } finally {
      await a.stop();
    }
  });

  // --------------------------------------------------------------------------
  // 3. Crash + failover: ownership-transfer leaks a subscription row.
  //
  // A subscribes (row S1), then is stopped WITHOUT running cleanup. A new
  // instance B starts the same process -> resubscribeSuspended INSERTs row S2
  // without touching S1. S1 is now an orphan owned by no executor.
  // --------------------------------------------------------------------------

  it('crash + failover: B cleans up the orphaned subscription from crashed A before inserting its own', async () => {
    const signalChannel = `pg_subleak_${db.name}_c`;
    const id = `orphan-${Date.now()}`;
    const instanceKey = `e2e-loop/${id}`;

    // Step 1: A starts the process and lands at the first race().
    const a = await makeInstance({ id: 'a', url: db.url, signalChannel, extra: [E2eSignals] });
    await startProcess(a, signalLoop, [id]);
    await waitFor(async () => {
      const rows = await sql`SELECT status FROM process_signal_subscriptions WHERE instance_id = ${instanceKey}`;
      return rows.length === 1 && rows[0].status === 'waiting';
    }, { timeout: 3000, label: 'A subscription registered' });

    // Step 2: Hard-stop A without giving it a chance to clean up.
    await a.stop();

    // Step 3: B takes over - resubscribeSuspended inserts a fresh row.
    const b = await makeInstance({ id: 'b', url: db.url, signalChannel, extra: [E2eSignals] });
    try {
      await startProcess(b, signalLoop, [id]);
      await delay(200);

      const rows = await sql<{ status: string }[]>`
        SELECT status FROM process_signal_subscriptions WHERE instance_id = ${instanceKey}`;

      assert.strictEqual(
        rows.length,
        1,
        `expected 1 subscription after failover (B should have cleaned up A's orphan), got ${rows.length}: ${rows.map(r => r.status).join(', ')}`,
      );
    } finally {
      await b.stop();
    }
  });
});
