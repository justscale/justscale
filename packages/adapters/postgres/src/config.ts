/**
 * Postgres config partials. One file so features can reference each
 * other's config without circular imports. Callers `.add(createConfig({
 * provides: [PostgresProcessConfig, PostgresMigrationConfig, ...], ... }))`
 * in their env.
 */

import { z } from 'zod';
import { defineConfigPartial } from '@justscale/core';

/**
 * LISTEN/NOTIFY channel + tuning for `PostgresProcessFeature`.
 */
export const PostgresProcessConfig = defineConfigPartial(
  'postgres:process',
  z.object({
    /**
     * Channel name for cross-instance signal distribution.
     * Use a per-run unique value for parallel test isolation.
     */
    signalChannel: z.string().default('process_signals'),
  }),
);

/**
 * Runtime migration settings for `PostgresMigrationFeature`.
 *
 * Deliberately does NOT carry a `directory` field - migrations are
 * discovered through the import graph (each file's `defineMigration()`
 * call registers into a module-level list), not by reading a directory
 * at runtime. That makes the runtime bundler-agnostic.
 */
export const PostgresMigrationConfig = defineConfigPartial(
  'postgres:migration',
  z.object({
    /** Table name tracking applied migrations. */
    table: z.string().default('_migrations'),
  }),
);

/**
 * Dev-only migration settings for `PostgresMigrationDevFeature`.
 *
 * `directory` is the target path that `just migrate make` writes
 * scaffolded migration files into. Not consumed at runtime - runtime
 * reads the registry populated by `defineMigration()` imports.
 */
export const PostgresMigrationDevConfig = defineConfigPartial(
  'postgres:migration-dev',
  z.object({
    /** Where `just migrate make` writes new migration files. */
    directory: z.string().default('./migrations'),
  }),
);

/**
 * Connection-pool tuning for the client provided by `PostgresFeature`.
 *
 * Entirely optional - omit it and the adapter's defaults apply (`max` 10,
 * idle 20s, connect 10s). Provide it to size the pool for your concurrency
 * (each held `repo.lock()` pins a pool connection, so a pod's pool should
 * cover its peak concurrent locked requests). This is the knob that used to
 * require dropping down to `createPostgresClient({ max })`.
 *
 * @example
 * ```typescript
 * createConfig({
 *   provides: [PostgresClientConfig],
 *   factory: () => ({ [PostgresClientConfig.key]: { max: 25 } }),
 * })
 * // or at runtime:  just config set postgres:client max 25
 * ```
 */
export const PostgresClientConfig = defineConfigPartial(
  'postgres:client',
  z.object({
    /** Max connections in the pool. Default 10. */
    max: z.number().int().positive().optional(),
    /** Seconds an idle connection is kept before closing. Default 20. */
    idleTimeout: z.number().int().nonnegative().optional(),
    /** Seconds to wait for a new connection before failing. Default 10. */
    connectTimeout: z.number().int().nonnegative().optional(),
  }),
);

declare module '@justscale/core' {
  interface RegisteredConfigPartials {
    postgresClient: typeof PostgresClientConfig;
    postgresProcess: typeof PostgresProcessConfig;
    postgresMigration: typeof PostgresMigrationConfig;
    postgresMigrationDev: typeof PostgresMigrationDevConfig;
  }
}
