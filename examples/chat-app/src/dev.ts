/**
 * Development-mode entrypoint. Adds the migration CLI on top of the
 * production composition. Dev runs against a real Postgres - start it
 * via `docker compose up -d` before `just dev`.
 */

import { defineApp } from '@justscale/core';
import { PostgresMigrationDevFeature } from '@justscale/postgres/dev';
import type { AppEnv } from './env-contract.js';
import makeApp from './app.js';

export default defineApp(import.meta, async (env: AppEnv) =>
  (await makeApp(env)).add(PostgresMigrationDevFeature),
);
