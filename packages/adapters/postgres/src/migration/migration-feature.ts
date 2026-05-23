/**
 * Postgres migration feature - prod-safe subset.
 *
 * Provides `migrate run`, `migrate status`, `migrate pending`,
 * `migrate rollback`. Deploy pipelines and oncall workflows stay intact
 * with just this.
 *
 * Dev-only migration commands (`make`, `fresh`, `verify`) live in
 * `migration-dev-feature.ts`, exported only from `@justscale/postgres/dev`
 * so bundlers can't tree-shake them *in* - an import from the top-level
 * package never reaches the dev controller.
 *
 * @example
 * ```ts
 * .add(env)                                  // provides PostgresMigrationConfig
 * .add(PostgresFeature)                      // client pool
 * .add(PostgresMigrationFeature)             // migrate run/status/...
 * ```
 */

import { AbstractLockProvider, Config, createFeatureBuilder } from '@justscale/core';
import { AbstractPostgresClient } from '../client/client.js';
import { PostgresMigrationConfig } from '../config.js';
import { MigrationController, MigrationService } from './migration-controller.js';
import { MigrationRunnerService } from './migration-runner.js';

export const PostgresMigrationFeature = createFeatureBuilder()
  .name('PostgresMigration')
  .requires(AbstractPostgresClient)
  .requires(AbstractLockProvider)
  .requires(Config.of(PostgresMigrationConfig))
  .provides((b) =>
    b.add(MigrationRunnerService).add(MigrationService).add(MigrationController),
  );
