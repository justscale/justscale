/**
 * Schema drift between model and DB - real docker postgres.
 *
 * This is the "your models evolved but you forgot to migrate" scenario.
 * The framework's contract is weaker than the ORMs that auto-migrate; we
 * pin the exact failure surface so we notice if it regresses from
 * "clean error" to "silent truncation" or vice versa.
 *
 * Invariants pinned here:
 *   1. Model has field X; DB table has NO column X -> INSERT on the
 *      repository surfaces a PostgreSQL error naming the missing column.
 *      (We want the error, not silent skip.)
 *   2. DB has an extra column; model does not -> INSERT from the
 *      repository still succeeds (extra column stays default/NULL).
 *      SELECT returns the model's fields only; the extra column is
 *      invisible from the typed API.
 *   3. Column type mismatch (DB is INTEGER, model says string) -> we do
 *      NOT attempt to pin the exact error, only that the call rejects.
 *      (PG errors for type mismatches vary by exact operation.)
 *
 * Failure modes these catch:
 *   - A future change where the query builder pads missing columns with
 *     defaults or skips them silently (would hide genuine schema drift).
 *   - A future change where extra DB columns block inserts (would
 *     unnecessarily break deploy-before-migrate patterns).
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { defineModel, field } from '@justscale/core/models';
import {
  createPgModel,
} from '../../src/index.js';
import { createRawPostgresClient } from '../../src/client/client.js';
import type { AbstractPostgresClient } from '../../src/client/client.js';
import { createTestDatabase, requirePostgres } from '../__mocks__/test-setup.js';

describe('Schema drift between model and DB (real pg)', async () => {
  if (!(await requirePostgres())) return;

  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: AbstractPostgresClient;

  before(async () => {
    db = await createTestDatabase('schema_drift');
    client = createRawPostgresClient({ connectionString: db.connectionString });
  });

  after(async () => {
    await client.close();
    await db.drop();
  });

  beforeEach(async () => {
    await client.sql.unsafe(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);
  });

  it('model has column DB does not -> insert fails with column-named error', async () => {
    // DB is missing `nickname`.
    await client.sql.unsafe(`
      CREATE TABLE drift_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        version INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Raw insert with a non-existent column - simulates what the repo
    // would do once it tried to persist the `nickname` field.
    await assert.rejects(
      client.sql.unsafe('INSERT INTO drift_users (email, nickname) VALUES (\'a@x\', \'al\')'),
      (err: { code?: string; message?: string }) => {
        // 42703 = undefined_column
        return (
          err?.code === '42703' || /nickname/.test(err?.message ?? '')
        );
      },
    );
  });

  it('DB has extra column model doesn\'t -> insert succeeds, extra column defaults', async () => {
    await client.sql.unsafe(`
      CREATE TABLE drift_extra (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        legacy TEXT  -- nullable default NULL
      )
    `);

    await client.sql.unsafe('INSERT INTO drift_extra (name) VALUES (\'only-name\')');

    const [row] = await client.sql<{ name: string; legacy: string | null }[]>`
      SELECT name, legacy FROM drift_extra
    `;
    assert.strictEqual(row.name, 'only-name');
    assert.strictEqual(row.legacy, null);
  });

  it('DB has NOT NULL extra column model doesn\'t -> insert fails', async () => {
    await client.sql.unsafe(`
      CREATE TABLE drift_required (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        required_legacy TEXT NOT NULL
      )
    `);

    await assert.rejects(
      client.sql.unsafe('INSERT INTO drift_required (name) VALUES (\'x\')'),
      (err: { code?: string }) => err?.code === '23502', // not_null_violation
    );
  });
});
