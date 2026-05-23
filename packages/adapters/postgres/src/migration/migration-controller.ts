/**
 * Migration CLI controller - DI-native.
 *
 * Injects `Config.of(PostgresMigrationConfig)` for directory/table and
 * `AbstractPostgresClient` for the shared pool. No factory-level
 * configuration - all knobs come through DI, matching the
 * "features declare requirements, not take config" pattern.
 *
 * Prod-safe commands (always ship):
 *   migrate run       Run all pending migrations
 *   migrate status    Show migration status
 *   migrate rollback  Rollback the last batch
 *   migrate pending   Show pending migrations
 *
 * Dev-only commands live in `migration-dev-controller.ts` - they either
 * scaffold files from model introspection (`make`) or wipe/touch the
 * schema (`fresh`, `verify`) and shouldn't be part of the production
 * CLI surface.
 *
 * @example
 * ```ts
 * .add(env)                               // provides PostgresMigrationConfig
 * .add(PostgresFeature)                   // client pool
 * .add(PostgresMigrationFeature)          // prod CLI (run/status/...)
 * // In dev.ts only, also:
 * .add(PostgresMigrationDevFeature)       // dev CLI (make/fresh/verify)
 * ```
 */

import { Config, createController, defineService } from '@justscale/core';
import { Cli } from '@justscale/core/cli';
import { AbstractPostgresClient } from '../client/client.js';
import { PostgresMigrationConfig } from '../config.js';
import { MigrationRunnerService } from './migration-runner.js';

/**
 * Bundle resolved by controller handlers: runner + client + the
 * tracking table name. Deliberately does NOT expose a `directory` -
 * runtime migrations live in the registry (populated by
 * `defineMigration()` imports), so no filesystem path is involved.
 * `just migrate make` reads its scaffold-target directory from
 * `PostgresMigrationDevConfig` instead.
 */
export class MigrationService extends defineService({
  inject: {
    runner: MigrationRunnerService,
    client: AbstractPostgresClient,
    config: Config.of(PostgresMigrationConfig),
  },
  factory: ({ runner, client, config }) => ({
    runner,
    client,
    table: config.table,
  }),
}) {}

export const MigrationController = createController({
  inject: { svc: MigrationService },
  routes: ({ svc }) => ({
    migrateRun: Cli('migrate run').handle(async ({ io }) => {
      io.log('Running pending migrations...\n');
      const ran = await svc.runner.migrate();
      if (ran.length === 0) {
        io.log('Nothing to migrate. All migrations are up to date.');
      } else {
        io.log(`Ran ${ran.length} migration(s):`);
        for (const name of ran) io.log(`  \u2713 ${name}`);
      }
    }),

    migrateStatus: Cli('migrate status').handle(async ({ io }) => {
      const status = await svc.runner.status();
      if (status.length === 0) {
        io.log('No migration files found.');
        return;
      }
      io.log('Migration Status:\n');
      const rows = status.map((m) => ({
        Status: m.applied ? '\u2713' : '\u2717',
        Migration: m.name,
        Batch: m.batch?.toString() ?? '-',
      }));
      io.table(rows);
    }),

    migrateRollback: Cli('migrate rollback').handle(async ({ io }) => {
      io.log('Rolling back last batch...\n');
      const rolledBack = await svc.runner.rollback();
      if (rolledBack.length === 0) {
        io.log('Nothing to rollback.');
      } else {
        io.log(`Rolled back ${rolledBack.length} migration(s):`);
        for (const name of rolledBack) io.log(`  \u2713 ${name}`);
      }
    }),

    migratePending: Cli('migrate pending').handle(async ({ io }) => {
      const pending = await svc.runner.pending();
      if (pending.length === 0) {
        io.log('No pending migrations.');
      } else {
        io.log(`${pending.length} pending migration(s):\n`);
        for (const name of pending) io.log(`  ${name}`);
      }
    }),
  }),
});
