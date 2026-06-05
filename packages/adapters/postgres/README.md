# @justscale/postgres

PostgreSQL adapter for JustScale — client, repositories, migrations, distributed locks via advisory locks, and a channel backend that fans messages out over `LISTEN/NOTIFY`.

Requires **PostgreSQL 16+**.

## Install

```bash
pnpm add @justscale/postgres postgres
```

`postgres` (the `postgres.js` driver, v3.4.9+) is a peer dependency. This package ships a patch for `postgres@3.4.9`; install that exact minor or later. `@electric-sql/pglite` / `@electric-sql/pglite-socket` are optional peers used by the `/dev` and `/testing` subpath exports for in-process Postgres.

## Usage

```ts
import JustScale, { createSecretProvider } from '@justscale/core';
import {
  PostgresFeature,
  PostgresChannelFeature,
  PostgresLockFeature,
  PostgresProcessFeature,
  PostgresMigrationFeature,
  PostgresSecrets,
  createPgModel,
  createPgRepository,
} from '@justscale/postgres';
import { User } from './domain/user.js';

const Secrets = createSecretProvider({
  provides: [PostgresSecrets],
  factory: () => ({ [PostgresSecrets.key]: { connectionString: process.env.DATABASE_URL! } }),
});

const PgUser = createPgModel(User, { table: 'users' });
const UserRepository = createPgRepository(PgUser);

const app = JustScale()
  .add(Secrets)
  .add(PostgresFeature)         // provides AbstractPostgresClient
  .add(PostgresChannelFeature)  // provides AbstractChannelBackend (LISTEN/NOTIFY)
  .add(PostgresLockFeature)     // distributed advisory locks
  .add(PostgresProcessFeature)  // durable-process storage
  .add(PostgresMigrationFeature)
  .add(UserRepository)
  .build();
```

Services inject the abstract `ModelRepository.of(User)` token and stay storage-agnostic — the `createPgRepository` wiring stays in `app.ts`. `PostgresProcessFeature` binds the durable-process storage so `createProcess` handlers survive restarts. Tune the pool with a `PostgresClientConfig` partial (`max`, `idleTimeout`, `connectTimeout`) or `just config set postgres:client max 25`.

> Need a custom secret shape, multiple databases, or hand-built wiring? The low-level `createPostgresClient` / `createPostgresChannelBackend` factories live in `@justscale/postgres/advanced`.

## What's included

- **Client** — `PostgresFeature` provides `AbstractPostgresClient` from a `PostgresSecrets` connection string; pool tuning via the `PostgresClientConfig` partial (`max`, `idleTimeout`, `connectTimeout`). Implicit-transaction context via `getCurrentTransactionContext`.
- **Models + repositories** — `createPgModel` maps a `defineModel` class to a table; `createPgRepository` produces a DI-compatible `Repository<T>` with typed queries, locking, and change streams via `ModelChangeChannels`.
- **Locks** — `PostgresLockFeature` backs `@justscale/core/lock` with advisory locks. Strategies pick between `pg_advisory_lock` and a dedicated table; context tracking via `withLockContext` / `getCurrentLocks`.
- **Channel backend** — `PostgresChannelFeature` provides `AbstractChannelBackend`, fanning published channel messages out through `LISTEN/NOTIFY` so every instance on the same database sees each publish exactly once.
- **Pub/Sub primitive** — `createPostgresPubSub` if you want raw `LISTEN/NOTIFY` outside the channels abstraction.
- **Migrations** — `PostgresMigrationFeature` adds the `migrate` CLI subset (`run`, `status`, `pending`, `rollback`). Dev-only commands (`make`, `fresh`, `verify`) live under `@justscale/postgres/dev`.
- **Durable iteration** — `PgQueryIterator` drives `for await` loops inside durable processes with keyset pagination, so long-running jobs can resume mid-iterate.

## Subpath exports

- `@justscale/postgres` — production surface (features, repositories, migrations-prod, locks, channel, process storage).
- `@justscale/postgres/advanced` — low-level factories (`createPostgresClient`, `createPostgresChannelBackend`) for custom secret shapes, multiple databases, or hand-built wiring.
- `@justscale/postgres/dev` — dev-only migration commands (`make`, `fresh`, `verify`, auto-sync tooling) that need a writable workspace.
- `@justscale/postgres/testing` — `PostgresTestBundle`, pglite-based containers, TRUNCATE helpers for fast test isolation.

## Known limitations

**Cluster coordinator migration not included.** `ClusterNode` (multi-instance coordination) requires its own schema table. That migration is not yet shipped in this package — if you use `@justscale/core/cluster` with Postgres you will need to create the table manually. This will be resolved before 1.0.

## Docs

https://justscale.sh/docs/postgres/overview · https://justscale.sh/docs/repositories/overview · https://justscale.sh/docs/fundamentals/locks · https://justscale.sh/docs/fundamentals/channels
