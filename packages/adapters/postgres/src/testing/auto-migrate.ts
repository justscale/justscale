/**
 * Runs the app's file-based migrations during container resolution.
 *
 * The factory awaits `runner.migrate()` before returning, so by the
 * time `app.ready` resolves, the pglite DB has the migration history
 * applied. Bundled inside `PostgresTestBundle`.
 *
 * Test-only - in prod you want to see migrations applied deliberately
 * (via `just migrate run`), not implicitly on every boot.
 */

import { defineService } from '@justscale/core';
import { MigrationRunnerService } from '../migration/migration-runner.js';

export class AutoMigrateOnStartService extends defineService({
  inject: { runner: MigrationRunnerService },
  factory: async ({ runner }) => {
    await runner.migrate();
    return { migrated: true as const };
  },
}) {}
