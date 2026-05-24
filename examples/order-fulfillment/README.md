# Order Fulfillment

The durable side of JustScale: a long-running workflow written as plain async
code that survives restarts and resumes across instances. (For the everyday
HTTP + service shape, start with [`url-shortener`](../url-shortener).)

This example is an order-fulfillment workflow written as if it ran on one
machine: place an order, then wait for payment or time out. There is no queue
wiring, no state machine table, no cross-node messaging code. JustScale
compiles the durable process into a Postgres-backed state machine, so a process
started on one node is transparently resumed by a signal sent from another.

## The durable process

```ts
export const orderFulfillment = createProcess({
  path: '/order/:order/fulfillment',
  types: { order: Order },
  inject: { orders: OrderService, repo: ModelRepository.of(Order) },
  async handler({ orders, repo }, { order }) {
    const r = race();
    switch (true) {
      case signal(r, orders.paymentConfirmed):
        await setStatus(repo, orders, order, 'fulfilled');
        return { status: 'fulfilled' as const };
      case delay.minutes(r, 15):
        await setStatus(repo, orders, order, 'cancelled');
        return { status: 'cancelled' as const };
    }
  },
});
```

`race()` waits for whichever happens first: a `paymentConfirmed` signal, or a
15 minute timeout. On payment the order becomes `fulfilled`; on timeout it
becomes `cancelled`. The handler reads as ordinary single-threaded code -- the
framework supplies persistence, locking, and cross-node signal routing.

## Layout

```
src/
  app.ts                                 composes the Postgres-backed app
  domains/order/
    order.model.ts                       defineModel (no id/createdAt/updatedAt)
    order.signals.ts                     defineSignals
    order.service.ts                     defineService (Locked<T> mutators)
    order-fulfillment.process.ts         createProcess
  infra/pg/order.pg.ts                   createPgModel + createPgRepository
test/
  order-fulfillment.pg.e2e.test.ts       single-process Postgres e2e
  multi-instance.e2e.test.ts             two real Node processes via shared Postgres
  multi-instance/worker.ts               worker entrypoint for the above
```

## Run it

```bash
# From the repo root, start Postgres (docker-compose.yml ships with the repo)
docker compose up -d

# Then, from this directory
pnpm test
```

The tests create and drop a throwaway database per run. If Postgres is not
reachable they skip cleanly rather than fail.

## How it scales

`test/multi-instance.e2e.test.ts` is the proof. It spawns two real OS
processes that share nothing but one Postgres database:

- Worker A starts `orderFulfillment` and suspends in Postgres, holding the
  advisory lock for that process execution.
- Worker B -- a separate process -- confirms payment. The signal travels
  through Postgres `LISTEN/NOTIFY`.
- The process that A started wakes up and flips the order to `fulfilled`.

No shared memory, no HTTP between the nodes. The same domain code that runs on
one machine runs correctly across a cluster, unchanged.
