/**
 * Test-mode entrypoint. Swaps Postgres for pglite and the channel backend
 * for an in-memory one. Multi-instance tests use a pglite *socket* so
 * several `createTestApp` instances can share a single pglite — see
 * test/multi-instance.e2e.test.ts.
 */

import { AbstractChannelBackend, MemoryChannelBackend, bindService, defineApp } from '@justscale/core';
import { PostgresTestBundle } from '@justscale/postgres/testing';
import type { AppEnv } from './env-contract.js';
import makeApp from './app.js';

export default defineApp(import.meta, async (env: AppEnv) =>
  (await makeApp(env))
    .add(PostgresTestBundle())
    .add(bindService(AbstractChannelBackend, MemoryChannelBackend)),
);
