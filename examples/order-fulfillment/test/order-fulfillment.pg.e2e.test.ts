import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import { ModelRepository } from '@justscale/core/models';
import { AbstractChannelBackend } from '@justscale/core';
import {
  PgProcessExecution,
  PgSignalSubscription,
  type AbstractPostgresClient,
} from '@justscale/postgres';
import { PgSchemaIntrospection } from '@justscale/postgres/testing';
import { AbstractProcessExecutor, AbstractSignalBus, TestClock } from '@justscale/core/process';

import { Order } from '../src/domains/order/order.model.js';
import { OrderService } from '../src/domains/order/order.service.js';
import { orderFulfillment } from '../src/domains/order/order-fulfillment.process.js';
import { PgOrder } from '../src/infra/pg/order.pg.js';
import { buildApp } from '../src/app.js';

const BASE_CONNECTION_STRING =
  process.env.DATABASE_URL ?? `postgresql://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/justscale_test`;

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
  const dbName = `test_order_fulfillment_${suffix}`;
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

async function waitForSubscription(
  bus: InstanceType<typeof AbstractSignalBus>,
  signalName: string,
  identity: Record<string, string>,
  timeout = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const subs = await bus.findSubscriptions(signalName, identity);
    if (subs.length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timeout waiting for subscription to signal "${signalName}"`);
}

describe('Order Fulfillment (Postgres e2e)', { timeout: 30000 }, async () => {
  if (!(await checkPostgres())) {
    test.skip('PostgreSQL not available', () => {});
    return;
  }

  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let sql: ReturnType<typeof postgres>;
  let built: any;
  let app: any;
  let client: AbstractPostgresClient;
  let clock: TestClock;
  let signalBus: InstanceType<typeof AbstractSignalBus>;
  let orderSvc: any;

  before(async () => {
    testDb = await createTestDb();
    sql = postgres(testDb.connectionString);

    const { built: b, PostgresClient } = buildApp(testDb.connectionString);
    built = b;
    app = built.compile();
    await app.ready;

    client = await app.container.resolve(PostgresClient);
    await new PgSchemaIntrospection(client).sync(...ALL_PG_MODELS);

    const executor = await app.container.resolve(AbstractProcessExecutor);
    const timerScheduler = (executor as any).timerScheduler;
    timerScheduler.stop();
    clock = new TestClock(timerScheduler);

    signalBus = await app.container.resolve(AbstractSignalBus);
    orderSvc = await app.container.resolve(OrderService);
  });

  beforeEach(async () => {
    for (const table of [...ALL_PG_MODELS.map((m) => m.table)].reverse()) {
      await sql.unsafe(`TRUNCATE ${table} CASCADE`).catch(() => {});
    }
  });

  after(async () => {
    await built.stop();
    const channelBackend = await app.container.resolve(AbstractChannelBackend);
    if (channelBackend && typeof channelBackend.close === 'function') {
      await channelBackend.close();
    }
    await client.close();
    await sql.end();
    await testDb.drop();
  });

  test('payment confirmed -> fulfilled', async () => {
    const order = await orderSvc.place({ customerEmail: 'buyer@example.com', amount: '49.99' });

    const handle = await orderFulfillment([Order.ref(order)]);
    assert.strictEqual(clock.pendingCount, 1, 'timeout timer should be pending');

    const identity = { order: Order.ref(order).identifier };
    await waitForSubscription(signalBus, 'order.order.payment-confirmed', identity);
    await orderSvc.confirmPayment(Order.ref(order));

    const result = await handle.wait();
    assert.ok(result);
    assert.strictEqual(result.status, 'fulfilled');

    const finalOrder = await orderSvc.get(Order.ref(order));
    assert.strictEqual(finalOrder!.status, 'fulfilled');
  });

  test('timeout -> cancelled', async () => {
    const order = await orderSvc.place({ customerEmail: 'slow@example.com', amount: '12.00' });

    const handle = await orderFulfillment([Order.ref(order)]);
    assert.strictEqual(clock.pendingCount, 1, 'timeout timer should be pending');

    // Fire the 15 minute timeout timer -> process resumes on the delay branch.
    clock.fireNext();

    const result = await handle.wait();
    assert.ok(result);
    assert.strictEqual(result.status, 'cancelled');

    const finalOrder = await orderSvc.get(Order.ref(order));
    assert.strictEqual(finalOrder!.status, 'cancelled');
  });
});
