/**
 * Test bundle - ephemeral pglite + migrations applied on start.
 *
 * Replaces the combo `.add(PgliteFeature).add(PostgresMigrationFeature)
 * .add(some-sync-helper)` that e2e tests used to wire by hand. Each
 * `PostgresTestBundle()` call is independent - the underlying pglite
 * instance gets its own socket + in-memory DB, so tests don't leak
 * state across each other.
 *
 * @example
 * ```ts
 * import JustScale from '@justscale/core';
 * import { PostgresTestBundle } from '@justscale/postgres/testing';
 *
 * const built = JustScale()
 *   .add(envForTest)              // must provide PostgresMigrationConfig
 *   .add(PostgresTestBundle())
 *   .add(...app features)
 *   .build();
 * ```
 */

import {
  AbstractLockProvider,
  Config,
  Lifecycle,
  Logger,
  createFeatureBuilder,
} from '@justscale/core';

import { PostgresMigrationConfig } from '../config.js';
import { PostgresMigrationFeature } from '../migration/migration-feature.js';
import { PgliteFeature } from './pglite-feature.js';
import { AutoMigrateOnStartService } from './auto-migrate.js';

export function PostgresTestBundle() {
  return createFeatureBuilder()
    .name('postgres-test')
    // Built-ins + the migration config the caller's env supplies.
    .requires(Logger)
    .requires(Lifecycle)
    .requires(Config.of(PostgresMigrationConfig))
    // The migration runner now requires an explicit lock provider. Test
    // callers that compose this bundle on top of the prod app already get
    // PostgresLockFeature; tests that wire only the bundle should add
    // `InMemoryLockProvider` (or another provider) themselves.
    .requires(AbstractLockProvider)
    .provides((b) =>
      b
        .add(PgliteFeature)
        .add(PostgresMigrationFeature)
        .add(AutoMigrateOnStartService),
    );
}
