# JustScale

The TypeScript backend framework where plain code just scales.

**[Documentation →](https://justscale.sh)** &nbsp;·&nbsp; [Philosophy](https://justscale.sh/docs/overview/philosophy) &nbsp;·&nbsp; [Quick Start](https://justscale.sh/docs/overview/quick-start) &nbsp;·&nbsp; [Why it scales](https://justscale.sh/docs/advanced/why-it-scales)

[![npm](https://img.shields.io/npm/v/%40justscale%2Fcore?label=%40justscale%2Fcore)](https://www.npmjs.com/package/@justscale/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-24%2B-brightgreen)](#requirements)

JustScale is a general-purpose TypeScript backend framework. You write plain,
straight-line code and it just scales - from one instance to many.

The compiler makes long-running workflows durable, the type system keeps it
correct, and domain code never sees a string ID. Like Go, where blocking code
just scales - for TypeScript backends.

```typescript
// A model is pure domain data - storage owns the id, your code never sees it.
export class Link extends defineModel({
  name: 'Link',
  fields: { slug: field.string().unique(), target: field.text() },
}) {}

// A service is plain methods over injected dependencies - no transport, no SQL.
export class Links extends defineService({
  inject: { links: ModelRepository.of(Link) },
  factory: ({ links }) => ({
    async shorten(slug: string, target: string) {
      return links.insert({ slug, target });
    },

    async resolve(slug: string) {
      return links.findOne(Link.fields.slug.eq(slug));
    },
  }),
}) {}

// A controller maps HTTP onto the service - the only place that knows about HTTP.
export const links = createController('/', {
  inject: { svc: Links },
  routes: ({ svc }) => ({
    go: Get('/:slug').handle(async ({ params, res }) => res.json(await svc.resolve(params.slug))),
  }),
});
```

That's the whole app: a model, a service, a controller. The type system wires
the dependencies at compile time and catches mistakes - try to mutate without a
`Locked<T>` and it won't compile - and the same code runs unchanged from one
instance to many. Long-running work is just as plain; see durable processes
below.

## What's in the box

- **Services & DI** — `defineService` with function-based injection (no
  decorators, no reflect-metadata); missing dependencies fail the build,
  not the prod node.
- **ID-free domain** — `Ref<T>` / `Persistent<T>` / `Locked<T>` flow
  through your code; storage owns IDs.
- **Safe mutations** — `repo.update` / `save` / `delete` require
  `Locked<T>`. The only way to obtain one is
  `using x = await repo.lock(ref)` — atomic with the read.
- **Transport-agnostic controllers** — the same route definition is
  served by HTTP, CLI, and Server-Sent Events today; WebSocket and gRPC
  graduate from `next` as those packages settle.
- **Durable processes** — `createProcess` workflows written as plain
  async code that survive restarts and route across instances.
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
(`websocket`, `event`, `redis`, `permission`, ...) graduate
out of `next` as their APIs settle.

| Package | Description |
|-|-|
| `@justscale/core` | DI, services, controllers, durable processes, models, cluster, CLI |
| `@justscale/typescript` | Custom TypeScript compiler (`ptsc`), tsserver, register hook |
| `@justscale/testing` | `createTestKit` harness, mocks, in-memory adapters |
| `@justscale/http` | HTTP route factories, body limits, CORS, OpenAPI hooks |
| `@justscale/sse` | Server-Sent Events route factory + streaming handlers |
| `@justscale/postgres` | Repositories, migrations, advisory locks, LISTEN/NOTIFY |
| `@justscale/auth` | User/Session models, password hashing, auth middleware |
| `create-justscale` | Project scaffolder (`npx create-justscale my-app`) |

## Requirements

- Node.js 24+
- pnpm 10.6+ (for development)
- PostgreSQL 16+ (for the postgres adapter)

Local dev runs against real Postgres via `docker compose up -d`.
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
pnpm test        # run tests (needs docker pg)
pnpm lint        # check linting
pnpm typecheck   # workspace typecheck
```

## License

[MIT](LICENSE)
