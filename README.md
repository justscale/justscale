# JustScale

The TypeScript backend framework where plain code just scales.

**[Documentation →](https://justscale.sh)** &nbsp;·&nbsp; [Philosophy](https://justscale.sh/docs/overview/philosophy) &nbsp;·&nbsp; [Quick Start](https://justscale.sh/docs/overview/quick-start) &nbsp;·&nbsp; [Why it scales](https://justscale.sh/docs/advanced/why-it-scales)

[![npm](https://img.shields.io/npm/v/%40justscale%2Fcore?label=%40justscale%2Fcore)](https://www.npmjs.com/package/@justscale/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-24%2B-brightgreen)](#requirements)

JustScale is a general-purpose TypeScript backend framework. You write plain,
straight-line code, and it scales from one instance to many.

The compiler makes long-running workflows durable, the type system keeps it
correct, and domain code never sees a string ID.

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
dependencies at compile time and catches mistakes. Try to mutate without a
`Locked<T>` and it won't compile. The same code runs unchanged from one
instance to many.

## What is JustScale for?

Use JustScale if you want:

- Type-safe backend architecture with compile-time dependency wiring
- Durable workflows and multi-instance scaling without rewriting app logic
- A monorepo-friendly stack with first-party Postgres and testing tooling

It may not be a fit if you:

- Need browser or frontend framework features
- Prefer runtime reflection and decorator-heavy patterns

## What's in the box

- **Services & DI** - `defineService` with function-based injection (no
decorators, no reflect-metadata); missing dependencies fail the build,
not the prod node.
- **ID-free domain** - `Ref<T>` / `Persistent<T>` / `Locked<T>` flow
through your code; storage owns IDs.
- **Safe mutations** - `repo.update` / `save` / `delete` require
`Locked<T>`. The only way to obtain one is
`using x = await repo.lock(ref)` - atomic with the read.
- **Transport-agnostic controllers** - the same route definition is
served by HTTP, CLI, and Server-Sent Events today; WebSocket and gRPC
graduate from `next` as those packages settle.
- **Durable processes** - `createProcess` workflows written as plain
async code that survive restarts and route across instances.
- **Custom TS compiler** (`ptsc`) - process transforms and IDE support.

## How it works

- `Model -> Repository -> Service -> Controller -> Protocol Adapter (HTTP/SSE)`
- Durable processes run alongside services and call the same typed APIs
- The compiler and type system enforce dependency wiring and mutation safety

## Install

```bash
npx create-justscale my-app
cd my-app
docker compose up -d  #If your app uses Postgres adapter
just dev
```

Then run one endpoint from the generated app to confirm your first request.

The installer detects your package manager and IDE, scaffolds a project
with an env-contract entrypoint (no `main.ts`, no manual `app.serve()`),
and ships JustScale-aware Claude Code skills under `.claude/skills/`.

## Packages

This 0.x release ships the tier-1 surface. More packages
(`websocket`, `event`, `redis`, `permission`, ...) graduate
out of `next` as their APIs settle.

| Package                 | Description                                                        |
|-------------------------|--------------------------------------------------------------------|
| `@justscale/core`       | DI, services, controllers, durable processes, models, cluster, CLI |
| `@justscale/typescript` | Custom TypeScript compiler (`ptsc`), tsserver, register hook       |
| `@justscale/testing`    | `createTestKit` harness, mocks, in-memory adapters                 |
| `@justscale/http`       | HTTP route factories, body limits, CORS, OpenAPI hooks             |
| `@justscale/sse`        | Server-Sent Events route factory + streaming handlers              |
| `@justscale/postgres`   | Repositories, migrations, advisory locks, LISTEN/NOTIFY            |
| `@justscale/auth`       | User/Session models, password hashing, auth middleware             |
| `create-justscale`      | Project scaffolder (`npx create-justscale my-app`)                 |

## Monorepo map

| Path                         | Package                 | Purpose                                                             |
|------------------------------|-------------------------|---------------------------------------------------------------------|
| `packages/core/core`         | `@justscale/core`       | Framework runtime primitives: DI, services, models, process runtime |
| `packages/core/typescript`   | `@justscale/typescript` | `ptsc`, tsserver integration, framework compiler features           |
| `packages/core/testing`      | `@justscale/testing`    | Test kit, mocks, framework-aware testing utilities                  |
| `packages/adapters/postgres` | `@justscale/postgres`   | Postgres repositories, migrations, locking, channels                |
| `packages/protocol/http`     | `@justscale/http`       | HTTP controller protocol adapter                                    |
| `packages/protocol/sse`      | `@justscale/sse`        | SSE protocol adapter and stream handlers                            |
| `packages/feature/auth`      | `@justscale/auth`       | Auth models, hashing, middleware                                    |
| `packages/misc/install`      | `create-justscale`      | Project scaffolder                                                  |
| `examples/url-shortener`     | Example app             | Minimal model/service/controller flow                               |
| `examples/order-fulfillment` | Example app             | Larger workflow and multi-instance-oriented example                 |

## Requirements

### App runtime requirements

- Node.js 24+
- PostgreSQL 16+ (for the Postgres adapter)

### Contributor requirements (this monorepo)

- Node.js 24+
- pnpm 10.6+
- Docker (for local Postgres in integration tests)

Local dev in this monorepo runs against real Postgres via `docker compose up -d`.
`pglite` is for tests and CLI tooling, not for `just dev`.

## Documentation

**[justscale.sh](https://justscale.sh)** - guides, concepts, reference,
and the visual explainer.

- [Introduction](https://justscale.sh/docs/overview/introduction)
- [Philosophy](https://justscale.sh/docs/overview/philosophy) - the nine principles
- [Why it scales](https://justscale.sh/docs/advanced/why-it-scales) - the proof, not the slogan

## Development

```bash
git clone https://github.com/justscale/justscale.git
cd justscale
pnpm install

docker compose up -d
pnpm build       # build all packages
pnpm test        # run tests (needs docker pg)
pnpm lint        # check linting
pnpm typecheck   # workspace typecheck
```

## Troubleshooting

- **`just dev` cannot connect to Postgres**: start local Postgres with `docker compose up -d` and verify your env values.
- **Unexpected Node or pnpm errors**: confirm versions match the requirements section.
- **Typecheck failures in workspace mode**: run `pnpm install` at repo root, then re-run `pnpm typecheck`.
- **Need a baseline**: run `pnpm build` first, then `pnpm test`.

## License

[MIT](LICENSE)
