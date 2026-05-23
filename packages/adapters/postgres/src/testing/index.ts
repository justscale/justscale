/**
 * PostgreSQL Testing Utilities - `@justscale/postgres/testing`.
 *
 * Test-only helpers. Not for dev compositions - local dev runs against
 * real Postgres via docker. Pglite is strictly a test artefact: an
 * in-process Postgres that gives every test an isolated socket + DB.
 *
 * The preferred composition is `PostgresTestBundle()`:
 *
 * ```ts
 * import JustScale from '@justscale/core';
 * import { PostgresTestBundle } from '@justscale/postgres/testing';
 *
 * const built = JustScale()
 *   .add(envForTest)              // provides PostgresMigrationConfig
 *   .add(PostgresTestBundle())    // pglite + migrations run on boot
 *   .add(...domain features)
 *   .build();
 * ```
 *
 * Direct-use classes are also exposed for bespoke setups:
 * `PgDatabaseOps`, `PgSchemaIntrospection`. Prefer the bundle.
 */

export { PgliteFeature } from './pglite-feature.js';
export { AutoMigrateOnStartService } from './auto-migrate.js';
export { PostgresTestBundle } from './test-bundle.js';

// Direct-use classes for non-bundle test setups.
export {
  PgDatabaseOps,
  PgDatabaseOpsService,
  generateCreateTableSQL,
  generateIndexSQL,
  generateDropTableSQL,
} from '../pg-database.js';

export {
  PgSchemaIntrospection,
  PgSchemaIntrospectionService,
  DestructiveMigrationError,
  type SyncOptions,
} from '../migration/migration.js';

export { pg } from '../model/pg-namespace.js';
