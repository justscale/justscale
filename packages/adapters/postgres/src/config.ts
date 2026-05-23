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

declare module '@justscale/core' {
  interface RegisteredConfigPartials {
    postgresProcess: typeof PostgresProcessConfig;
    postgresMigration: typeof PostgresMigrationConfig;
    postgresMigrationDev: typeof PostgresMigrationDevConfig;
  }
}
