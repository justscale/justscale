/**
 * Scheduled task stuck-recovery invariants.
 *
 * Claim: if a worker crashes after `pickNextDueTask` promotes a row to
 * Processing but before `markCompleted` runs, the row used to sit in
 * Processing forever - `resetStuck` existed on the repo but nothing
 * called it. A process waiting on `delay.minutes(r, 5)` would silently
 * lose its wake-up signal.
 *
 * Fix: `subscribe()` now periodically calls `resetStuck` inside its
 * poll loop, controlled by new `stuckAfterMs` / `stuckCheckEveryMs`
 * options on the core `SubscribeOptions` type. These probes lock in
 * the new behaviour.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  SCHEDULED_TASKS_MIGRATION,
  keyOf,
} from '../src/index.js';
import { createPostgresClient } from '../src/client/client.js';
import JustScale from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import { PgScheduledTaskRepository } from '../src/repository/pg-scheduled-task.repository.js';
import { AbstractPostgresClient } from '../src/client/client.js';
import { ScheduledTaskStatus } from '@justscale/core/models';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

const TABLE = 'scheduled_tasks_stuck_probe';

const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });
const built = JustScale()
  .add(InMemoryLockFeature)
  .add(InMemoryProcessFeature)
  .add(PostgresClient)
  .build();

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('PgScheduledTaskRepository: stuck-recovery', async () => {
  if (!(await requirePostgres())) return;

  let sql: postgres.Sql;
  let client: AbstractPostgresClient;
  let repo: PgScheduledTaskRepository;

  before(async () => {
    sql = postgres(CONNECTION_STRING);
    const app = built.compile();
    await app.ready;
    client = await app.container.resolve(AbstractPostgresClient);
    // Apply schema, with a rename for table isolation.
    const ddl = SCHEDULED_TASKS_MIGRATION.replaceAll('scheduled_tasks', TABLE);
    await client.sql.unsafe(ddl);
    repo = new PgScheduledTaskRepository(client, { tableName: TABLE });
  });

  after(async () => {
    await sql`DROP TABLE IF EXISTS ${sql(TABLE)}`;
    await sql.end();
    await client.close();
  });

  beforeEach(async () => {
    await sql`TRUNCATE ${sql(TABLE)}`;
  });

  test('INVARIANT: row manually set to Processing with stale started_at is reset to Pending by resetStuck', async () => {
    // Sanity: resetStuck itself works on directly-stuck rows. This test
    // asserts the building-block; the next test asserts the subscribe()
    // loop wires it automatically.
    const task = await repo.schedule({
      dueAt: new Date(),
      namespace: 'probe',
      type: 'recovery',
      payload: { kind: 'sanity' },
    });

    // Directly flip to Processing with started_at well in the past.
    const longAgo = new Date(Date.now() - 60_000);
    await sql`
      UPDATE ${sql(TABLE)}
      SET status = ${ScheduledTaskStatus.Processing}, started_at = ${longAgo}
      WHERE id = ${keyOf(task)}
    `;

    const n = await repo.resetStuck(new Date(Date.now() - 30_000));
    assert.strictEqual(n, 1, 'resetStuck must report 1 row reset');

    const [row] = await sql<{ status: string; started_at: Date | null }[]>`
      SELECT status, started_at FROM ${sql(TABLE)}
    `;
    assert.strictEqual(row.status, ScheduledTaskStatus.Pending);
    assert.strictEqual(row.started_at, null);
  });

  test('INVARIANT: subscribe() auto-recovers a row stuck in Processing (simulated worker crash)', async () => {
    // Schedule a task and manually promote it to Processing with an old
    // started_at, simulating: pickNextDueTask claimed it, worker crashed
    // before markCompleted could run. Without auto-recovery, the row sits
    // in Processing forever and subscribe() never sees it again.
    const task = await repo.schedule({
      dueAt: new Date(),
      namespace: 'probe',
      type: 'autorecover',
      payload: { kind: 'crash-sim' },
    });
    const longAgo = new Date(Date.now() - 5_000);
    await sql`
      UPDATE ${sql(TABLE)}
      SET status = ${ScheduledTaskStatus.Processing}, started_at = ${longAgo}
      WHERE id = ${keyOf(task)}
    `;

    const ctrl = new AbortController();
    let received = false;
    const consume = (async () => {
      for await (const _ of repo.subscribe('probe.autorecover', {
        signal: ctrl.signal,
        pollInterval: 50,
        stuckAfterMs: 1_000,
        stuckCheckEveryMs: 100,
      })) {
        received = true;
        break;
      }
    })();

    // Wait longer than the stuck threshold + a few poll cycles.
    const deadline = Date.now() + 4_000;
    while (!received && Date.now() < deadline) await delay(50);

    ctrl.abort();
    await consume.catch(() => {});

    assert.strictEqual(
      received,
      true,
      'subscribe() must auto-reset the stuck row and re-deliver it; without the fix this hangs until manual `resetStuck`',
    );
  });

  test('stuckAfterMs: false disables auto-recovery - stuck rows stay stuck', async () => {
    // Opt-out path for operators who want to manage stuck rows externally.
    const task = await repo.schedule({
      dueAt: new Date(),
      namespace: 'probe',
      type: 'optout',
      payload: {},
    });
    const longAgo = new Date(Date.now() - 5_000);
    await sql`
      UPDATE ${sql(TABLE)}
      SET status = ${ScheduledTaskStatus.Processing}, started_at = ${longAgo}
      WHERE id = ${keyOf(task)}
    `;

    const ctrl = new AbortController();
    let received = false;
    const consume = (async () => {
      for await (const _ of repo.subscribe('probe.optout', {
        signal: ctrl.signal,
        pollInterval: 50,
        stuckAfterMs: false,
      })) {
        received = true;
        break;
      }
    })();

    await delay(500);
    ctrl.abort();
    await consume.catch(() => {});

    assert.strictEqual(received, false, 'opt-out must leave stuck rows alone');

    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM ${sql(TABLE)} WHERE id = ${keyOf(task)}
    `;
    assert.strictEqual(row.status, ScheduledTaskStatus.Processing);
  });
});
