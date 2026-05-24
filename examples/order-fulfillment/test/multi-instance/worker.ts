/**
 * Worker entrypoint for the multi-instance order-fulfillment e2e.
 *
 * Spawned as a real OS process by the test driver. It shares ONE Postgres
 * with the driver and the sibling worker; the only coordination channel is
 * the database (advisory locks + LISTEN/NOTIFY). No shared memory, no HTTP.
 *
 * Env contract:
 *   DATABASE_URL = postgres connection string (shared by all processes)
 *   ORDER_ID     = string identifier of the Order to act on
 *   ROLE         = 'start'   -> start orderFulfillment, print STARTED, stay alive
 *                  'confirm' -> emit paymentConfirmed, print CONFIRMED, exit
 */

import { Order } from '../../src/domains/order/order.model.js';
import { OrderService } from '../../src/domains/order/order.service.js';
import { orderFulfillment } from '../../src/domains/order/order-fulfillment.process.js';
import { buildApp } from '../../src/app.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  const orderId = process.env.ORDER_ID;
  const role = process.env.ROLE;

  if (!connectionString || !orderId || !role) {
    process.stderr.write(`worker: missing env (DATABASE_URL/ORDER_ID/ROLE)\n`);
    process.exit(2);
  }

  const { built } = buildApp(connectionString);
  const app = built.compile();
  await app.ready;

  if (role === 'start') {
    // Start the durable process. It suspends in Postgres on the race; this
    // node holds the advisory lock for the process execution.
    await orderFulfillment([Order.ref(orderId)]);
    process.stdout.write(`STARTED\n`);

    // Keep the event loop alive so the suspended process can be resumed by a
    // signal NOTIFY from the sibling worker. Shut down on SIGTERM.
    const shutdown = async (): Promise<void> => {
      await built.stop().catch(() => {});
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
    setInterval(() => {}, 1 << 30);
    return;
  }

  if (role === 'confirm') {
    const svc = await app.container.resolve(OrderService);
    await svc.confirmPayment(Order.ref(orderId));
    process.stdout.write(`CONFIRMED\n`);
    // Give NOTIFY a moment to flush before tearing down the connection.
    await new Promise((r) => setTimeout(r, 250));
    await built.stop().catch(() => {});
    process.exit(0);
  }

  process.stderr.write(`worker: unknown ROLE "${role}"\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`worker fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
