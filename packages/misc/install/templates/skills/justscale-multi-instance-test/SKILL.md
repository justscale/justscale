---
name: justscale-multi-instance-test
description: Scaffold a JustScale multi-instance e2e test that spawns two real Node worker processes coordinating through a shared Postgres. Verifies cross-instance invariants — lock mutual exclusion, signal NOTIFY routing, channel delivery, process resumption across nodes. Use when testing distributed primitives, NEVER for single-node logic.
---

# Skill: justscale-multi-instance-test

Scaffold an e2e test that spawns TWO real worker processes and asserts an
invariant holds across them. The canonical pattern lives at
`examples/order-fulfillment/test/multi-instance.e2e.test.ts` — a process
started on one node, resumed by a signal sent through another, all
coordinated through one shared Postgres. Read it before extending it.

## Why two real processes

JustScale's distributed primitives — locks, channels, signals, durable
processes — are meaningless under a single Node process. A single-process
test cannot catch:

- Two nodes both believing they hold the same lock.
- A signal `NOTIFY` routing to the wrong process replica.
- A channel publish that the second subscriber misses.
- A durable process suspending on instance A and resuming on instance B.

For these primitives the multi-process test IS the test. Memory rule from
this repo: **don't fake the second instance with a mock or a second
builder in the same process**. The whole point is two real OS processes
coordinating through a real shared backend.

## Requirements

- Docker Postgres on port `5433` (default `PG_URL=postgres://justscale:justscale@localhost:5433/postgres`). Postgres alone is enough — locks (advisory), channels (LISTEN/NOTIFY), and durable processes all have Postgres backends in the public release.
- Redis is optional. If the Redis adapter is installed, parameterize the lock/channel backend to cover the mixed-adapter matrix too; otherwise stick to Postgres.
- The test should `before(...)` probe the backend and **skip with a clear message** if it's unreachable. Don't fail — let CI decide.

## Two-file pattern

A multi-instance test is always two files in the same folder:

1. **`<scenario>/worker.ts`** — the entrypoint each spawned process runs.
   Reads its wiring from env vars, builds the app, calls `listen()`,
   prints `READY <port>` to stdout once `app.ready` resolves.
2. **`<scenario>.e2e.test.ts`** — the driver. Spawns workers via
   `child_process.spawn`, talks to them over HTTP, asserts.

## Worker template

```typescript
// <scenario>/worker.ts
import { listen } from '@justscale/http';
import { makeApp } from './app.js';

async function main() {
  const port = Number(process.env.PORT);
  const pgUrl = process.env.PG_URL!;
  const redisUrl = process.env.REDIS_URL!;
  const lockBackend = process.env.LOCK_BACKEND as 'pg-advisory' | 'redis';
  const channelBackend = process.env.CHANNEL_BACKEND as 'pg' | 'redis' | 'memory';
  const instanceId = process.env.INSTANCE_ID ?? 'X';
  const prefix = process.env.CHANNEL_PREFIX!;

  const { builder } = makeApp({ port, pgUrl, redisUrl, lockBackend, channelBackend, instanceId, prefix });
  const built = builder.build();
  const app = built.compile();
  await app.ready;

  const server = listen(app, port);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  // Stdout liveness signal — the driver waits for this line.
  console.log(`READY ${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## Driver template

```typescript
// <scenario>.e2e.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, '<scenario>', 'worker.ts');
const TSX = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');

const PG_URL = process.env.PG_URL ?? 'postgres://justscale:justscale@localhost:5433/postgres';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

async function spawnWorker(opts: { port: number; instanceId: 'A' | 'B'; prefix: string }): Promise<ChildProcess> {
  const child = spawn(process.execPath, [TSX, WORKER], {
    env: {
      ...process.env,
      PORT: String(opts.port),
      INSTANCE_ID: opts.instanceId,
      CHANNEL_PREFIX: opts.prefix,
      PG_URL,
      REDIS_URL,
      LOCK_BACKEND: 'pg-advisory',
      CHANNEL_BACKEND: 'pg',
      JUSTSCALE_NO_SOCKET: '1', // no cluster socket — coordinate purely through pg/redis
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for the READY <port> liveness line on stdout
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes(`READY ${opts.port}`)) resolve();
    });
    child.once('exit', (code) => reject(new Error(`worker exited early (${code})`)));
    setTimeout(() => reject(new Error('worker boot timeout')), 15000);
  });

  return child;
}

describe('<scenario>', () => {
  let workerA: ChildProcess;
  let workerB: ChildProcess;

  before(async () => {
    // TODO: probe pg + redis liveness; skip if either is unreachable.
    const prefix = `<scenario>_${Date.now()}`;
    workerA = await spawnWorker({ port: 6401, instanceId: 'A', prefix });
    workerB = await spawnWorker({ port: 6402, instanceId: 'B', prefix });
  });

  after(async () => {
    workerA?.kill('SIGTERM');
    workerB?.kill('SIGTERM');
    await Promise.all([
      workerA && once(workerA, 'exit'),
      workerB && once(workerB, 'exit'),
    ]);
  });

  it('invariant holds across two instances', async () => {
    // 1. Trigger the action on workerA via HTTP (port 6401).
    // 2. Assert workerB observes the consequence (HTTP poll on 6402, or DB read).
    // 3. Assert no double-execution.
  });
});
```

## Before scaffolding, ask

1. **Invariant** — what should be true after the trigger? ("exactly one
   process resumed", "B observes the channel publish", "only one of A/B
   holds the lock at any moment".)
2. **Trigger** — what HTTP call on A produces the observable on B?
3. **Adapter set** — `pg-advisory` + `pg`, `redis` + `redis`, or mixed.
   Multi-adapter coverage is the whole point of `packages/misc/e2e/`.

## Anti-patterns

- **Don't** put both apps in one Node process via `JustScale().build()`
  twice. They'd share memory and module-level state — every distributed
  bug invisible.
- **Don't** mock the shared backend. The point is a real Postgres (and
  Redis, if you're covering it) under contention.
- **Don't** rely on `app.serve({ socketPath })`. The cluster socket is for
  CLI ↔ app, not for two workers to find each other. Set
  `JUSTSCALE_NO_SOCKET=1` and coordinate through the chosen distributed
  adapters.

## After scaffolding

- Print both file paths.
- Remind the user: run with `tsx --test <driver>`. Don't add to the
  package's `test` script until it passes twice clean — leaked workers
  between runs are the most common failure mode.
- Read the canonical e2e
  (`examples/order-fulfillment/test/multi-instance.e2e.test.ts`) for
  details on liveness probes, port collision avoidance, and how a process
  started on one node is driven to completion by a signal from another.
