import {
  AbstractChannelBackend,
  Logger,
  Secret,
  createFeatureBuilder,
  defineService,
} from '@justscale/core';
import { AbstractPostgresClient, createRawPostgresClient } from './client/client.js';
import { PostgresChannelBackend } from './channel/channel-backend.js';
import { PostgresSecrets } from './secrets.js';

/**
 * Service form of `createRawPostgresClient` that pulls its connection
 * string from `Secret.of(PostgresSecrets)`. Bundled inside `PostgresFeature`
 * - exported separately so apps with a custom feature shape can still
 * reuse it.
 */
// Kept as `const defineService(...)` rather than `class extends
// defineService({...}) {}` because the factory's declared return type
// (`AbstractPostgresClient`) is an abstract class with abstract members.
// A class-form wrapper would inherit the abstract members, forcing us
// to either declare the wrapper abstract (breaking DI instantiation)
// or re-implement every method. The const form sidesteps that - the
// resulting ServiceDef is identical at runtime.
export const PostgresClientService = defineService({
  inject: { secrets: Secret.of(PostgresSecrets), logger: Logger },
  provides: [AbstractPostgresClient],
  factory: ({ secrets, logger }) =>
    createRawPostgresClient({ connectionString: secrets.connectionString }, logger),
});

/**
 * Channel backend used by `PostgresProcessFeature` for cross-instance
 * signal distribution via LISTEN/NOTIFY. Opens its own dedicated
 * connection (Postgres requires a separate connection for LISTEN), fed
 * from the same `PostgresSecrets` partial as the main client pool.
 */
export const PostgresChannelBackendService = defineService({
  inject: { secrets: Secret.of(PostgresSecrets), logger: Logger },
  provides: [AbstractChannelBackend],
  factory: ({ secrets, logger }) =>
    new PostgresChannelBackend({ connectionString: secrets.connectionString }, logger),
});

/**
 * Postgres client pool - the foundational feature for any Postgres-backed
 * app. Provides `AbstractPostgresClient`.
 *
 * Unlike earlier versions, this no longer bundles the channel backend
 * (LISTEN/NOTIFY). Apps that need pub/sub explicitly add
 * `PostgresChannelFeature`. Apps using Postgres only as a client pool
 * (e.g. read-only analytics workers) don't pay for an extra connection
 * they don't use.
 *
 * Requires:
 * - `Secret.of(PostgresSecrets)` - provided by the environment's secret
 *   provider (vault / env-var).
 *
 * Provides:
 * - `AbstractPostgresClient`
 *
 * @example
 * ```typescript
 * import JustScale from '@justscale/core'
 * import {
 *   PostgresFeature,
 *   PostgresChannelFeature,
 *   PostgresLockFeature,
 *   PostgresProcessFeature,
 *   PostgresMigrationFeature,
 * } from '@justscale/postgres'
 *
 * JustScale()
 *   .add(env)                        // supplies PostgresSecrets
 *   .add(PostgresFeature)            // client pool
 *   .add(PostgresChannelFeature)     // LISTEN/NOTIFY (only if needed)
 *   .add(PostgresLockFeature)        // distributed locks
 *   .add(PostgresProcessFeature)     // durable process storage
 *   .build()
 * ```
 */
export const PostgresFeature = createFeatureBuilder()
  .name('Postgres')
  .requires(Secret.of(PostgresSecrets))
  // Logger is always provided by the container at runtime, but the feature
  // builder's type system doesn't know that - declare it so the inner
  // services (which inject Logger) type-check inside `.provides`.
  .requires(Logger)
  .provides((b) => b.add(PostgresClientService));

/**
 * LISTEN/NOTIFY channel backend for Postgres-backed pub/sub. Needed by
 * `PostgresProcessFeature` for cross-instance signal distribution, and by
 * any user code using `AbstractChannelBackend`. Opens a dedicated Postgres
 * connection (required for LISTEN - pool connections can't LISTEN).
 *
 * Requires:
 * - `Secret.of(PostgresSecrets)`
 *
 * Provides:
 * - `AbstractChannelBackend`
 */
export const PostgresChannelFeature = createFeatureBuilder()
  .name('PostgresChannel')
  .requires(Secret.of(PostgresSecrets))
  .requires(Logger)
  .provides((b) => b.add(PostgresChannelBackendService));
