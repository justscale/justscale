/**
 * THE headline test.
 *
 * Two real OS processes share ONE Postgres database. Worker A starts the
 * orderFulfillment process and suspends in Postgres. Worker B, a separate
 * process, confirms payment -- the signal travels through Postgres NOTIFY
 * and resumes the process that A started. The driver then observes the order
 * row flip to 'fulfilled'. Nothing is shared but the database.
 *
 * Requires docker postgres from the repo root (`docker compose up -d`).
 * A fresh database is created inline and dropped afterwards.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { AbstractChannelBackend } from '@justscale/core';
import { PgProcessExecution, PgSignalSubscription, type AbstractPostgresClient } from '@justscale/postgres';
import { PgSchemaIntrospection } from '@justscale/postgres/testing';

import { Order } from '../src/domains/order/order.model.js';
import { OrderService } from '../src/domains/order/order.service.js';
import { PgOrder } from '../src/infra/pg/order.pg.js';
import { buildApp } from '../src/app.js';

const BASE_CONNECTION_STRING =
  process.env.DATABASE_URL ?? `postgresql://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/justscale_test`;

const WORKER_PATH = fileURLToPath(new URL('./multi-instance/worker.ts', import.meta.url));
const ALL_PG_MODELS = [PgOrder, PgProcessExecution, PgSignalSubscription];

async function checkPostgres(): Promise<boolean> {
  try {
    const sql = postgres(BASE_CONNECTION_STRING, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

async function createTestDb(): Promise<{ connectionString: string; drop: () => Promise<void> }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const dbName = `test_order_multi_${suffix}`;
  const admin = postgres(BASE_CONNECTION_STRING, { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const connectionString = BASE_CONNECTION_STRING.replace(/\/[^/]+$/, `/${dbName}`);
  return {
    connectionString,
    async drop() {
      const adm = postgres(BASE_CONNECTION_STRING, { max: 1 });
      await adm.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
      );
      await adm.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adm.end();
    },
  };
}

// Spawn a worker under the same loader the test suite runs under.
function spawnWorker(role: 'start' | 'confirm', connectionString: string, orderId: string): ChildProcess {
  return spawn(
    process.execPath,
    ['--import', '@justscale/typescript/register', '--import', 'tsx', WORKER_PATH],
    {
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
        ORDER_ID: orderId,
        ROLE: role,
        JUSTSCALE_NO_SOCKET: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

// Resolve when the worker prints `marker` on stdout, reject on timeout/exit.
function waitForLine(child: ChildProcess, marker: string, timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${marker}"`)), timeout);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      if (buf.includes(marker)) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (c: Buffer) => process.stderr.write(`[worker ${marker}] ${c.toString()}`));
    child.once('exit', (code) => {
      if (!buf.includes(marker)) {
        clearTimeout(timer);
        reject(new Error(`Worker exited (code ${code}) before printing "${marker}"`));
      }
    });
  });
}

describe('Order Fulfillment cross-node resumption (Postgres e2e)', { timeout: 60000 }, async () => {
  if (!(await checkPostgres())) {
    test.skip('PostgreSQL not available', () => {});
    return;
  }

  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let sql: ReturnType<typeof postgres>;
  let built: any;
  let app: any;
  let client: AbstractPostgresClient;
  let orderSvc: any;
  const children: ChildProcess[] = [];

  before(async () => {
    testDb = await createTestDb();
    sql = postgres(testDb.connectionString);
    const { built: b, PostgresClient } = buildApp(testDb.connectionString);
    built = b;
    app = built.compile();
    await app.ready;

    client = await app.container.resolve(PostgresClient);
    await new PgSchemaIntrospection(client).sync(...ALL_PG_MODELS);
    orderSvc = await app.container.resolve(OrderService);
  });

  after(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await built?.stop().catch(() => {});
    const channelBackend = await app.container.resolve(AbstractChannelBackend);
    if (channelBackend && typeof channelBackend.close === 'function') {
      await channelBackend.close();
    }
    await client?.close();
    await sql.end();
    await testDb.drop();
  });

  test('process started on node A is resumed by a signal from node B', async () => {
    const order = await orderSvc.place({ customerEmail: 'cross@example.com', amount: '99.00' });
    const orderId = Order.ref(order).identifier;

    // Node A: start the process, then stay alive (suspended in Postgres).
    const workerA = spawnWorker('start', testDb.connectionString, orderId);
    children.push(workerA);
    await waitForLine(workerA, 'STARTED', 20000);

    // Node B: confirm payment. The signal travels through Postgres NOTIFY and
    // resumes the process that A started.
    const workerB = spawnWorker('confirm', testDb.connectionString, orderId);
    children.push(workerB);
    await waitForLine(workerB, 'CONFIRMED', 20000);

    // Driver: poll the order row via raw SQL until A's process flips it. We
    // read straight from the table rather than through our own repository so
    // the driver's identity map (still holding the inserted awaiting_payment
    // snapshot) cannot mask the cross-node update.
    const deadline = Date.now() + 15000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT status FROM orders WHERE id = ${orderId}`;
      status = rows[0]?.status as string | undefined;
      if (status === 'fulfilled') break;
      await new Promise((r) => setTimeout(r, 200));
    }

    assert.strictEqual(status, 'fulfilled', 'order should be fulfilled by the process A started');

    workerA.kill('SIGTERM');
  });
});
