/**
 * Shared e2e test helpers for the multi-instance Postgres adapter tests.
 *
 * - `createSharedDb(suite)`  -> create+init schema, return { url, drop }.
 * - `makeInstance(opts)`     -> bring up a real JustScale app against that DB
 *   with PostgresFeature + PostgresChannelFeature + PostgresLockFeature +
 *   PostgresProcessFeature. Skips the migration feature and applies the SQL
 *   schema inline so tests don't depend on the virtual/migrations loader
 *   (which reads `process.cwd()/migrations`).
 */

import postgres from 'postgres';
import JustScale, {
  createEnvironment,
  HardcodedVault,
  buildProviders,
  AbstractChannelBackend,
  AbstractLockProvider,
  Logger,
} from '@justscale/core';
import {
  AbstractSignalBus,
  AbstractProcessExecutor,
} from '@justscale/core/process';
import {
  PostgresFeature,
  PostgresChannelFeature,
  PostgresLockFeature,
  PostgresProcessFeature,
  postgresProcessEnv,
  postgresSecret,
} from '../../src/index.js';

// ============================================================================
// Connection configuration
// ============================================================================

const BASE_CONNECTION_STRING =
  process.env.DATABASE_URL
    ?? `postgres://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/postgres`;

/** Check whether the docker postgres is reachable. */
export async function checkPg(): Promise<boolean> {
  try {
    const sql = postgres(BASE_CONNECTION_STRING, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Schema (inline - matches the minimal runtime schema)
// ============================================================================

const RUNTIME_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS process_signal_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  instance_id VARCHAR(512) NOT NULL,
  type VARCHAR(10) NOT NULL DEFAULT 'signal',
  signal VARCHAR(255),
  identity JSON NOT NULL DEFAULT '{}',
  branches JSON,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting',
  matched_payload JSON,
  matched_branch_id VARCHAR(64),
  queued_payloads JSON NOT NULL DEFAULT '[]'
)`,
  `CREATE TABLE IF NOT EXISTS process_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1,
  process_id VARCHAR(255) NOT NULL,
  instance_id VARCHAR(512) NOT NULL UNIQUE,
  code_version VARCHAR(64) NOT NULL,
  pc INTEGER NOT NULL DEFAULT 0,
  variables JSON NOT NULL DEFAULT '{}',
  timers JSON NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  result JSON,
  error TEXT,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
)`,
];

// ============================================================================
// Per-test database creation
// ============================================================================

export interface SharedDb {
  name: string
  url: string
  drop: () => Promise<void>
  /** Terminates every connection to the DB (simulates a cluster-wide crash). */
  terminateAll: () => Promise<void>
}

export async function createSharedDb(suiteName: string): Promise<SharedDb> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const dbName = `jsclae2e_${suiteName}_${suffix}`.toLowerCase();

  const admin = postgres(BASE_CONNECTION_STRING, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const url = BASE_CONNECTION_STRING.replace(/\/[^/]+$/, `/${dbName}`);

  const sql = postgres(url, { max: 1 });
  try {
    for (const stmt of RUNTIME_SCHEMA_SQL) {
      await sql.unsafe(stmt);
    }
  } finally {
    await sql.end();
  }

  return {
    name: dbName,
    url,
    async drop() {
      const adm = postgres(BASE_CONNECTION_STRING, { max: 1 });
      try {
        await adm.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
        );
        await adm.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await adm.end();
      }
    },
    async terminateAll() {
      const adm = postgres(BASE_CONNECTION_STRING, { max: 1 });
      try {
        await adm.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
        );
      } finally {
        await adm.end();
      }
    },
  };
}

// ============================================================================
// Instance creation
// ============================================================================

export interface InstanceHandle {
  built: ReturnType<ReturnType<typeof JustScale>['build']>
  app: ReturnType<ReturnType<ReturnType<typeof JustScale>['build']>['compile']>
  stop: () => Promise<void>
}

export interface MakeInstanceOptions {
  id: string
  url: string
  /**
   * LISTEN/NOTIFY channel used by the signal bus. MUST match across
   * instances in the same test for cross-instance signal delivery to work.
   */
  signalChannel: string
  /** Optional extra builder components (processes, services). */
  extra?: Array<unknown>
}

export async function makeInstance(opts: MakeInstanceOptions): Promise<InstanceHandle> {
  const env = createEnvironment({
    name: `pg-e2e-${opts.id}`,
    type: 'test',
    services: [HardcodedVault({ 'postgres/url': opts.url })],
    providers: buildProviders([
      postgresProcessEnv({ signalChannel: opts.signalChannel }),
      postgresSecret('postgres/url'),
    ]),
  });

  let builder: any = JustScale().add(env);
  builder = builder.add(PostgresFeature);
  builder = builder.add(PostgresChannelFeature);
  builder = builder.add(PostgresLockFeature);
  builder = builder.add(PostgresProcessFeature);

  for (const comp of opts.extra ?? []) {
    builder = builder.add(comp);
  }

  const built = builder.build();
  const app = built.compile();
  await app.ready;

  return {
    built,
    app,
    stop: () => built.stop().catch(() => {}),
  };
}

// ============================================================================
// Misc helpers
// ============================================================================

export const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => T | Promise<T>,
  opts: { timeout?: number; step?: number; label?: string } = {},
): Promise<T> {
  const { timeout = 5000, step = 50, label = 'predicate' } = opts;
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    last = v;
    await delay(step);
  }
  throw new Error(`waitFor(${label}) timed out after ${timeout}ms (last=${JSON.stringify(last)})`);
}

export {
  AbstractChannelBackend,
  AbstractLockProvider,
  AbstractProcessExecutor,
  AbstractSignalBus,
  Logger,
};
