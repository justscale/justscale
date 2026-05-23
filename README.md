# JustScale

The TypeScript backend that survives the restart.

JustScale lets you write workflows as plain async code. The compiler makes
them durable. The type system makes them distributed-safe. Domain code
never sees a string ID.

```typescript
export const orderFulfillment = createProcess({
  path: '/order/:order/fulfillment',
  types: { order: Order },
  inject: { signals: OrderSignals, shipping: ShippingService },

  async handler({ signals, shipping }, { order }) {
    const r = race();
    switch (true) {
      case signal(r, signals.paymentConfirmed):
        await shipping.dispatch(r.order, r.txId);
        return { status: 'shipped' as const };
      case delay.days(r, 3):
        return { status: 'payment_timeout' as const };
    }
  },
});
```

This process suspends on `signal()` and `delay()`, persists its state at
every suspension point, and resumes after a server restart with the same
variables in scope. The compiler turns it into an opcode-based state
machine; you never see that.

## What's in the box

- **Durable processes** — `createProcess` workflows that survive
  restarts and route across instances.
- **ID-free domain** — `Ref<T>` / `Persistent<T>` / `Locked<T>` flow
  through your code; storage owns IDs.
- **Distributed-safe by construction** — `repo.update` / `save` /
  `delete` require `Locked<T>`. The only way to obtain one is
  `using x = await repo.lock(ref)` — atomic with the read.
- **Transport-agnostic controllers** — same routes serve HTTP,
  WebSocket, gRPC, CLI, SSE.
- **Compile-time DI** — missing dependencies fail the build, not the
  prod node.
- **Custom TS compiler** (`ptsc`) — process transforms + IDE support.

## Install

```bash
npx create-justscale my-app
cd my-app
just dev
```

The installer detects your package manager and IDE, scaffolds a project
with an env-contract entrypoint (no `main.ts`, no manual `app.serve()`),
and ships JustScale-aware Claude Code skills under `.claude/skills/`.

## Packages

This 0.x release ships the tier-1 surface. More packages
(`websocket`, `sse`, `event`, `redis`, `permission`, ...) graduate
out of `next` as their APIs settle.

| Package | Description |
|-|-|
| `@justscale/core` | DI, services, controllers, durable processes, models, cluster, CLI |
| `@justscale/typescript` | Custom TypeScript compiler (`ptsc`), tsserver, register hook |
| `@justscale/testing` | `createTestKit` harness, mocks, in-memory adapters |
| `@justscale/http` | HTTP route factories, body limits, CORS, OpenAPI hooks |
| `@justscale/postgres` | Repositories, migrations, advisory locks, LISTEN/NOTIFY |
| `@justscale/auth` | User/Session models, password hashing, auth middleware |
| `create-justscale` | Project scaffolder (`npx create-justscale my-app`) |

## Requirements

- Node.js 24+
- pnpm 10.6+ (for development)
- PostgreSQL 16+ (for the postgres adapter)
- Redis 7+ (for the redis adapter)

Local dev runs against real Postgres / Redis via `docker compose up -d`.
`pglite` is for tests + CLI tooling, not for `just dev`.

## Documentation

**[justscale.sh](https://justscale.sh)** — guides, concepts, reference,
and the visual explainer.

- [Introduction](https://justscale.sh/docs/overview/introduction)
- [Philosophy](https://justscale.sh/docs/overview/philosophy) — the
  nine principles
- [Why it scales](https://justscale.sh/docs/advanced/why-it-scales) —
  the proof, not the slogan

## Development

```bash
git clone https://github.com/justscale/justscale.git
cd justscale
pnpm install

pnpm build       # build all packages
pnpm test        # run tests (needs docker pg + redis)
pnpm lint        # check linting
pnpm typecheck   # workspace typecheck
```

## License

[MIT](LICENSE)
