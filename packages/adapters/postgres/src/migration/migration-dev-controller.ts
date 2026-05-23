/**
 * Migration CLI controller - **dev-only** commands.
 *
 * These commands either scaffold files from model introspection
 * (`migrate make`) or wipe/touch the database (`migrate fresh`,
 * `migrate verify`). They have no place in a production CLI surface:
 *
 * - `migrate fresh` drops and re-runs everything - prod-catastrophic.
 * - `migrate make <name>` generates a migration file from the live
 *   `createPgModel()` registry, a design-time activity.
 * - `migrate verify` creates a scratch schema to replay migrations,
 *   which needs CREATE SCHEMA privilege and leaves artifacts on error
 *   paths.
 *
 * Add `PostgresMigrationDevFeature` in `dev.ts` to make these
 * available locally; the prod composition in `app.ts` should not.
 */

import { execSync } from 'node:child_process';
import { Config, createController } from '@justscale/core';
import { Cli } from '@justscale/core/cli';
import { z } from 'zod';
import { PostgresMigrationDevConfig } from '../config.js';
import { MigrationService } from './migration-controller.js';
import { getRegisteredPgModels } from '../model/pg-model.js';
import { PgMigrationGeneratorService, writeMigration } from './migration-generator.js';
import { migrationName } from './migration-schema.js';

export const MigrationDevController = createController({
  inject: {
    svc: MigrationService,
    generator: PgMigrationGeneratorService,
    devConfig: Config.of(PostgresMigrationDevConfig),
  },
  routes: ({ svc, generator, devConfig }) => ({
    migrateFresh: Cli('migrate fresh').handle(async ({ io }) => {
      io.log('Resetting database...\n');
      const ran = await svc.runner.fresh();
      io.log(`Ran ${ran.length} migration(s) fresh:`);
      for (const name of ran) io.log(`  \u2713 ${name}`);
    }),

    migrateMake: Cli('migrate make')
      .input(z.object({ name: z.string() }))
      .handle(async ({ io, args }) => {
        const { name } = args;
        const pending = await svc.runner.pending();
        if (pending.length > 0) {
          io.error('Cannot generate migration: there are pending migrations.');
          io.log('');
          io.log('Run pending migrations first:');
          io.log('  just migrate run');
          io.log('');
          io.log(`Pending (${pending.length}):`);
          for (const p of pending) io.log(`  - ${p}`);
          return;
        }

        io.log(`\nGenerating migration: ${name}\n`);

        const models = getRegisteredPgModels();
        if (models.length === 0) {
          io.log('No PgModels found in this process.');
          io.log('');
          io.log('Create models via `createPgModel(Model, { table })` before running `migrate make`.');
          io.log('Importing the app module (where models are defined) is enough - no manual list required.');
          io.log('');
          return;
        }

        // Stamp once - the file name and the emitted \`name:\` field
        // must agree, since the runner sorts by \`name\`.
        const stamped = migrationName(name);
        const result = await generator.generateDiff([...models], { name: stamped });
        if (!result.hasChanges) {
          io.log('No schema changes detected.');
          io.log('Your models match the database schema.');
          return;
        }

        const filepath = await writeMigration(devConfig.directory, stamped, result.code, { stamped: true });
        try {
          execSync(`git add ${filepath}`, { stdio: 'ignore' });
        } catch {
          // Not a git repo - ignore.
        }

        io.log('Schema changes detected:');
        for (const change of result.changes) {
          const target = change.column ? `${change.table}.${change.column}` : change.table;
          io.log(`  ${change.type.padEnd(22)} ${target}`);
        }
        io.log(`\nMigration created: ${filepath}`);
        io.log('\nNext steps:');
        io.log('  1. Review the generated migration file');
        io.log('  2. Run: just migrate run');
      }),

    migrateVerify: Cli('migrate verify').handle(async ({ io }) => {
      const testSchema = `_verify_${Date.now()}`;
      io.log('Verifying migrations...\n');
      io.log(`Creating test schema: ${testSchema}`);
      try {
        await svc.client.sql`CREATE SCHEMA ${svc.client.sql(testSchema)}`;
        await svc.client.sql`SET search_path TO ${svc.client.sql(testSchema)}`;

        io.log('Running all migrations from scratch...');
        const ran = await svc.runner.fresh();
        io.log(`  Ran ${ran.length} migration(s)`);

        await svc.client.sql`SET search_path TO public`;

        const publicTables = await svc.client.sql<{ tablename: string }[]>`
          SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        `;
        const testTables = await svc.client.sql<{ tablename: string }[]>`
          SELECT tablename FROM pg_tables WHERE schemaname = ${testSchema}
        `;

        const publicSet = new Set(publicTables.map((t) => t.tablename));
        const testSet = new Set(testTables.map((t) => t.tablename));
        publicSet.delete(svc.table);
        testSet.delete(svc.table);

        const missingInTest = [...publicSet].filter((t) => !testSet.has(t));
        const extraInTest = [...testSet].filter((t) => !publicSet.has(t));
        let hasErrors = false;

        if (missingInTest.length > 0) {
          hasErrors = true;
          io.error('\nTables in public but not created by migrations:');
          for (const t of missingInTest) io.log(`  - ${t}`);
        }
        if (extraInTest.length > 0) {
          hasErrors = true;
          io.error('\nTables created by migrations but not in public:');
          for (const t of extraInTest) io.log(`  - ${t}`);
        }
        if (!hasErrors) {
          io.log('\n\u2713 Migrations verified successfully!');
          io.log('  All migrations replay to the same schema state.');
        }
      } finally {
        await svc.client.sql`SET search_path TO public`;
        await svc.client.sql`DROP SCHEMA IF EXISTS ${svc.client.sql(testSchema)} CASCADE`;
      }
    }),
  }),
});
