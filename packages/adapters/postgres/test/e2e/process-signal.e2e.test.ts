/**
 * Process + signal routing - multi-instance pg conformance.
 *
 * Verifies:
 *   1. A process suspended on instance A receives a signal emitted from B.
 *   2. Starting the same process with the same params on two instances ->
 *      only one handler row is created; the loser no-ops.
 *   3. Different params -> parallel instances, both run.
 *   4. Signal with no waiter -> no crash.
 *   5. Race between signals delivered from different instances narrows
 *      correctly.
 *   6. Service await inside a race branch completes via pg executor.
 *   7. Nested-if with naked break inside a race branch completes via pg executor.
 *   8. delay.seconds actually fires against pg timer storage.
 *   9. A simple quick-delay process runs to completion.
 *
 * Requires the `.process.ts` loader - node must be started with
 * `--import @justscale/typescript/register --import tsx`. When run
 * through `pnpm test` that's how the postgres package script invokes
 * node.
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AbstractProcessExecutor, withExecutor } from '@justscale/core/process';
import postgres from 'postgres';

import { checkPg, createSharedDb, makeInstance, delay, waitFor, type SharedDb, type InstanceHandle } from './helpers.js';
import { E2eSignals } from './fixtures/e2e-signals.js';
import {
  waitGo,
  raceGoAlt,
  awaitInBranch,
  nestedIfBreak,
  quickDelay,
} from './fixtures/e2e-processes.process.js';

/**
 * Invoke a compiled process callable under a specific executor's scope.
 * Avoids the module-level `setProcessExecutor` race between two apps in
 * the same test process - whichever ran last wins, so we pin per-call.
 */
interface ProcHandle<T> { wait(): Promise<T> }
async function startProcess<T>(
  app: InstanceHandle,
  proc: any,
  params: readonly unknown[],
): Promise<ProcHandle<T>> {
  const executor = await app.app.container.resolve(AbstractProcessExecutor);
  return withExecutor(executor as any, () => proc(params) as any);
}

const hasPg = await checkPg();

describe('Process + signal (pg runtime, multi-instance)', { skip: !hasPg ? 'docker postgres not reachable' : false }, () => {
  let db: SharedDb;
  let sql: ReturnType<typeof postgres>;
  let a: InstanceHandle;
  let b: InstanceHandle;

  before(async () => {
    db = await createSharedDb('process');
    sql = postgres(db.url);
    // Single shared signalChannel -> NOTIFY on A wakes subscribers on B.
    const signalChannel = `pg_proc_${db.name}`;
    a = await makeInstance({ id: 'a', url: db.url, signalChannel, extra: [E2eSignals] });
    b = await makeInstance({ id: 'b', url: db.url, signalChannel, extra: [E2eSignals] });
  });

  after(async () => {
    await a?.stop();
    await b?.stop();
    await sql?.end();
    await db?.drop();
  });

  it('signal emitted on B wakes process started on A', async () => {
    const id = `wake-${Date.now()}`;
    const signalsB = await b.app.container.resolve(E2eSignals);

    const handle = await startProcess<unknown>(a,waitGo, [id]);
    // Give the suspension a beat to land in the DB.
    await delay(250);

    const [row] = await sql`
      SELECT status FROM process_executions WHERE instance_id = ${`e2e-wait/${id}`}
    `;
    assert.ok(row, 'process row should exist');
    assert.strictEqual(row.status, 'suspended');

    // Emit from B - should reach A via pg NOTIFY.
    await signalsB.go({ id, note: 'hello-from-b' });

    const result = await Promise.race([
      handle.wait(),
      delay(5000).then(() => null),
    ]);
    assert.ok(result, 'process should resume and complete within 5s');
    assert.deepStrictEqual(result, { id, outcome: 'got-go', note: 'hello-from-b' });
  });

  it('race between signals from different instances narrows correctly', async () => {
    const id = `race-${Date.now()}`;
    const signalsB = await b.app.container.resolve(E2eSignals);

    const handle = await startProcess<unknown>(a,raceGoAlt, [id]);
    await delay(250);

    // Emit `alt` from B -> race should narrow to `alt`.
    await signalsB.alt({ id, note: 'alt-wins' });

    const result = await Promise.race([
      handle.wait(),
      delay(5000).then(() => null),
    ]);
    assert.ok(result, 'process should resume');
    assert.deepStrictEqual(result, { id, winner: 'alt', note: 'alt-wins' });
  });

  it('starting same process+id on two instances -> one row, not two', async () => {
    const id = `dedup-${Date.now()}`;

    // Start on both - whichever takes the advisory lock runs; the other
    // should proxy (or at minimum NOT create a second row).
    const [hA, hB] = await Promise.all([
      startProcess<unknown>(a, waitGo, [id]),
      startProcess<unknown>(b, waitGo, [id]),
    ]);
    assert.ok(hA && hB);

    await delay(400);

    const rows = await sql`
      SELECT instance_id FROM process_executions WHERE instance_id = ${`e2e-wait/${id}`}
    `;
    assert.strictEqual(rows.length, 1, `expected exactly 1 row for a shared process; got ${rows.length}`);

    // Clean up: emit the signal so the process completes.
    const signalsA = await a.app.container.resolve(E2eSignals);
    await signalsA.go({ id, note: 'cleanup' });
    await delay(400);
  });

  it('different params -> both processes run in parallel', async () => {
    const id1 = `par1-${Date.now()}`;
    const id2 = `par2-${Date.now()}`;
    const signalsB = await b.app.container.resolve(E2eSignals);

    const [h1, h2] = await Promise.all([
      startProcess<unknown>(a, waitGo, [id1]),
      startProcess<unknown>(a, waitGo, [id2]),
    ]);
    await delay(250);

    // Both should have their own row.
    const rows = await sql`
      SELECT instance_id FROM process_executions WHERE instance_id = ${`e2e-wait/${id1}`} OR instance_id = ${`e2e-wait/${id2}`}
    `;
    assert.strictEqual(rows.length, 2, 'two different params -> two rows');

    await signalsB.go({ id: id1, note: 'a' });
    await signalsB.go({ id: id2, note: 'b' });

    const [r1, r2] = await Promise.all([
      Promise.race([h1.wait(), delay(5000).then(() => null)]),
      Promise.race([h2.wait(), delay(5000).then(() => null)]),
    ]);
    assert.deepStrictEqual(r1, { id: id1, outcome: 'got-go', note: 'a' });
    assert.deepStrictEqual(r2, { id: id2, outcome: 'got-go', note: 'b' });
  });

  it('signal emitted with no matching waiter -> no crash', async () => {
    const signalsA = await a.app.container.resolve(E2eSignals);
    // Emit to a never-started id. Should resolve without error.
    await signalsA.go({ id: `nobody-${Date.now()}`, note: 'void' });
    // If we get here, no crash.
    assert.ok(true);
  });

  it('service await inside a race branch completes via pg executor', async () => {
    const id = `awaitbr-${Date.now()}`;
    const signalsB = await b.app.container.resolve(E2eSignals);

    const handle = await startProcess<unknown>(a,awaitInBranch, [id]);
    await delay(250);
    await signalsB.go({ id, note: 'hi' });

    const result = await Promise.race([
      handle.wait(),
      delay(5000).then(() => null),
    ]);
    assert.ok(result, 'process should resume + complete the awaited expression');
    assert.deepStrictEqual(result, { id, outcome: 'go', echo: 'hi' });
  });

  it('nested-if with naked break inside race branch completes via pg executor', async () => {
    const id = `nested-${Date.now()}`;
    const signalsB = await b.app.container.resolve(E2eSignals);

    const handle = await startProcess<unknown>(a,nestedIfBreak, [id]);
    await delay(250);

    // First go with non-empty note -> hits naked break -> loops.
    await signalsB.go({ id, note: 'loop' });
    await delay(400);

    // Second go with note='stop' -> returns.
    await signalsB.go({ id, note: 'stop' });

    const result = await Promise.race([
      handle.wait(),
      delay(5000).then(() => null),
    ]);
    assert.ok(result, 'process should complete after second signal');
    assert.deepStrictEqual(result, { id, stopped: true });
  });

  it('delay.seconds fires against pg timer storage', async () => {
    const id = `delay-${Date.now()}`;
    const handle = await startProcess<unknown>(a, quickDelay, [id]);

    const result = await Promise.race([
      handle.wait(),
      delay(5000).then(() => null),
    ]);
    assert.ok(result, 'timer-backed process should complete within 5s');
    assert.deepStrictEqual(result, { id, outcome: 'timer-fired' });
  });

  it('completed process state survives on disk (pg_executions row completed)', async () => {
    const id = `done-${Date.now()}`;
    const signalsA = await a.app.container.resolve(E2eSignals);

    const handle = await startProcess<unknown>(a, waitGo, [id]);
    await delay(250);
    await signalsA.go({ id, note: 'persist' });
    await handle.wait();

    // Allow the runtime's final write to flush.
    await delay(200);

    const rows = await waitFor(async () => {
      const r = await sql`
        SELECT status, result FROM process_executions WHERE instance_id = ${`e2e-wait/${id}`}
      `;
      if (r.length === 1 && r[0].status === 'completed') return r;
      return null;
    }, { timeout: 3000, step: 100, label: 'completed-row' });

    assert.ok(rows);
    assert.strictEqual(rows[0].status, 'completed');
    assert.deepStrictEqual(rows[0].result, { id, outcome: 'got-go', note: 'persist' });
  });
});
