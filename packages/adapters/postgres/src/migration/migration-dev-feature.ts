/**
 * Postgres migration feature - dev-only subset.
 *
 * Exports `PostgresMigrationDevFeature`, which contributes the
 * `migrate make`, `migrate fresh`, and `migrate verify` CLI commands
 * on top of the prod feature's core services. Kept in its own module
 * (not re-exported from `migration-feature.ts`) so bundlers can't
 * accidentally drag the dev controller into a production bundle via
 * a side-effect-unsafe re-export.
 *
 * Available only from the `@justscale/postgres/dev` subpath.
 */

import { Config, createFeatureBuilder } from '@justscale/core';
import { AbstractPostgresClient } from '../client/client.js';
import { PostgresMigrationDevConfig } from '../config.js';
import { MigrationService } from './migration-controller.js';
import { MigrationDevController } from './migration-dev-controller.js';
import { PgMigrationGeneratorService } from './migration-generator.js';
import { PgSchemaIntrospectionService } from './migration.js';

export const PostgresMigrationDevFeature = createFeatureBuilder()
  .name('PostgresMigrationDev')
  .requires(MigrationService)
  .requires(AbstractPostgresClient)
  .requires(Config.of(PostgresMigrationDevConfig))
  .provides((b) =>
    b.add(PgSchemaIntrospectionService).add(PgMigrationGeneratorService).add(MigrationDevController),
  );
