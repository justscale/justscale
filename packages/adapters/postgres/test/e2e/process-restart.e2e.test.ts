/**
 * Process state persistence across instance restart.
 *
 * A process suspended on instance A survives A being stopped. The state
 * row stays in `process_executions`; a fresh instance B started afterwards
 * picks up the signal and resumes from the stored pc/vars.
 *
 * This is THE distributed resilience guarantee: pods restart, work
 * continues.
 *
 * Matrix:
 *   1. Start on A, stop A, start B, emit signal on B -> process completes
 *      with state preserved from the suspension point.
 *   2. Completed process does NOT re-run when a new instance boots.
 *   3. Starting the same process again on the new instance is idempotent
 *      (detects the completed row).
 */

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { AbstractProcessExecutor, withExecutor } from '@justscale/core/process';

import { checkPg, createSharedDb, makeInstance, delay, type SharedDb, type InstanceHandle } from './helpers.js';
import { E2eSignals } from './fixtures/e2e-signals.js';
import { waitGo } from './fixtures/e2e-processes.process.js';

const hasPg = await checkPg();

async function start<T>(app: InstanceHandle, proc: any, params: readonly unknown[]): Promise<{ wait(): Promise<T> }> {
  const executor = await app.app.container.resolve(AbstractProcessExecutor);
  return withExecutor(executor as any, () => proc(params) as any);
}

describe('Process state persistence across restart (pg)', { skip: !hasPg ? 'docker postgres not reachable' : false }, () => {
  let db: SharedDb;
  let sql: ReturnType<typeof postgres>;
  let signalChannel: string;

  before(async () => {
    db = await createSharedDb('restart');
    sql = postgres(db.url);
    signalChannel = `pg_restart_${db.name}`;
  });

  after(async () => {
    await sql?.end();
    await db?.drop();
  });

  it('suspend on A -> stop A -> start B -> signal on B -> completes from stored state', async () => {
    const id = `survive-${Date.now()}`;

    // 1. Bring up A, start process, wait for it to suspend.
    const a = await makeInstance({ id: 'a', url: db.url, signalChannel, extra: [E2eSignals] });
    await start<unknown>(a, waitGo, [id]);
    await delay(300);

    const [sus] = await sql`SELECT status, pc, variables FROM process_executions WHERE instance_id = ${`e2e-wait/${id}`}`;
    assert.ok(sus, 'process row should exist after start');
    assert.strictEqual(sus.status, 'suspended', 'process should be suspended');
    const pcAtSuspend = Number(sus.pc);

    // 2. Stop A - simulate pod crash/restart.
    await a.stop();

    // Row should still be there with status=suspended and the same pc.
    const [after] = await sql`SELECT status, pc, variables FROM process_executions WHERE instance_id = ${`e2e-wait/${id}`}`;
    assert.strictEqual(after.status, 'suspended', 'row survives A stopping');
    assert.strictEqual(Number(after.pc), pcAtSuspend, 'pc preserved');

    // 3. Bring up fresh B, emit signal - process should wake and complete.
    const b = await makeInstance({ id: 'b', url: db.url, signalChannel, extra: [E2eSignals] });
    try {
      // Nudge B to subscribe to this instance's signal path (the signal bus
      // re-subscribes suspended processes on executor.start; we don't have
      // the process handle on B yet, so trigger a passive re-scan by
      // starting the same process ID - idempotent thanks to advisory lock
      // + existing row detection.)
      const h = await start<unknown>(b, waitGo, [id]);
      await delay(200);

      const signalsB = await b.app.container.resolve(E2eSignals);
      await signalsB.go({ id, note: 'resumed' });

      const result = await Promise.race([
        h.wait(),
        delay(5000).then(() => null),
      ]);
      assert.ok(result, 'process should resume + complete on B');
      assert.deepStrictEqual(result, { id, outcome: 'got-go', note: 'resumed' });
    } finally {
      await b.stop();
    }
  });

  it('completed process does NOT re-run when a new instance boots', async () => {
    const id = `no-rerun-${Date.now()}`;

    // Run to completion on A.
    const a = await makeInstance({ id: 'a', url: db.url, signalChannel, extra: [E2eSignals] });
    const signalsA = await a.app.container.resolve(E2eSignals);
    const h = await start<unknown>(a, waitGo, [id]);
    await delay(200);
    await signalsA.go({ id, note: 'done' });
    const result = await h.wait();
    assert.deepStrictEqual(result, { id, outcome: 'got-go', note: 'done' });
    await a.stop();

    const [row1] = await sql`SELECT status, completed_at FROM process_executions WHERE instance_id = ${`e2e-wait/${id}`}`;
    assert.strictEqual(row1.status, 'completed');
    const completedAt1 = row1.completed_at;
    assert.ok(completedAt1, 'should have completed_at timestamp');

    // Boot B - it loads all registered processes but MUST NOT re-execute
    // the completed one.
    const b = await makeInstance({ id: 'b', url: db.url, signalChannel, extra: [E2eSignals] });
    try {
      await delay(500);

      const [row2] = await sql`SELECT status, completed_at FROM process_executions WHERE instance_id = ${`e2e-wait/${id}`}`;
      assert.strictEqual(row2.status, 'completed', 'row stays completed');
      // completed_at must not change - no re-run.
      assert.strictEqual(
        new Date(row2.completed_at).toISOString(),
        new Date(completedAt1).toISOString(),
        'completed_at unchanged (no re-run)',
      );
    } finally {
      await b.stop();
    }
  });

  it('starting a completed process is idempotent (returns completed result)', async () => {
    const id = `idem-${Date.now()}`;

    const a = await makeInstance({ id: 'a', url: db.url, signalChannel, extra: [E2eSignals] });
    try {
      const signalsA = await a.app.container.resolve(E2eSignals);
      const h1 = await start<unknown>(a, waitGo, [id]);
      await delay(200);
      await signalsA.go({ id, note: 'first' });
      const r1 = await h1.wait();

      // Second "start" - should short-circuit to the completed result.
      const h2 = await start<unknown>(a, waitGo, [id]);
      const r2 = await Promise.race([
        h2.wait(),
        delay(2000).then(() => 'timeout'),
      ]);
      assert.deepStrictEqual(r2, r1, 'idempotent start returns stored result');
    } finally {
      await a.stop();
    }
  });
});
