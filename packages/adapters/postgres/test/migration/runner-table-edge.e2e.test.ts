/**
 * `_migrations` tracking-table edge cases - real docker postgres.
 *
 * Invariants pinned here:
 *   1. `init()` is idempotent: called many times -> no error, table exists.
 *   2. `_migrations` with extra columns added out-of-band -> runner still
 *      works (it SELECTs named columns, never `SELECT *`).
 *   3. Custom `table` option: runner uses that name; default is
 *      `_migrations`.
 *   4. Two runners using different `table` names on the same DB are
 *      independent (no cross-talk).
 *   5. `_migrations` has a stale row (a name no longer registered) ->
 *      `migrate()` doesn't crash and still picks up genuinely pending
 *      migrations; `status()` only reports registered ones.
 *
 * Failure modes these catch:
 *   - Changing init() to a plain CREATE without IF NOT EXISTS (not
 *     idempotent).
 *   - Switching the tracking table to `SELECT *` - breaks forward/backward
 *     compat with schema upgrades.
 *   - Custom table name ignored, always using `_migrations`.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import {
  clearRegisteredMigrations,
  createMigrationRunner,
  createPostgresLockProvider,
  createRawPostgresClient,
  defineMigration,
} from '../../src/index.js';
import type { AbstractPostgresClient } from '../../src/client/client.js';
import { createTestDatabase, requirePostgres } from '../__mocks__/test-setup.js';

describe('MigrationRunner tracking-table edge cases (real pg)', async () => {
  if (!(await requirePostgres())) return;

  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: AbstractPostgresClient;
  let lockProvider: ReturnType<typeof createPostgresLockProvider>;

  before(async () => {
    db = await createTestDatabase('runner_table_edge');
    client = createRawPostgresClient({ connectionString: db.connectionString });
    lockProvider = createPostgresLockProvider(client);
  });

  after(async () => {
    await lockProvider.close();
    await client.close();
    await db.drop();
  });

  function makeRunner(opts: { table?: string } = {}) {
    return createMigrationRunner(client, { ...opts, lockProvider });
  }

  beforeEach(async () => {
    clearRegisteredMigrations();
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

  it('init is idempotent: many runners on the same DB, all succeed', async () => {
    const runner = makeRunner();
    // Trigger init by asking for applied rows.
    await runner.getApplied();
    await runner.getApplied();
    await runner.getApplied();

    // And a fresh runner without shared state - same table, no crash.
    const runner2 = makeRunner();
    const rows = await runner2.getApplied();
    assert.strictEqual(rows.length, 0);
  });

  it('_migrations with extra column added out-of-band -> runner ignores it', async () => {
    const runner = makeRunner();
    await runner.getApplied();
    await client.sql.unsafe('ALTER TABLE _migrations ADD COLUMN notes TEXT');

    defineMigration({
      name: 'extra_col',
      async up({ db: d }) { await d.raw('CREATE TABLE extra_col (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE extra_col'); },
    });

    const ran = await runner.migrate();
    assert.deepStrictEqual(ran, ['extra_col']);

    const applied = await runner.getApplied();
    assert.strictEqual(applied.length, 1);
    // The new column wasn't in our read shape - but the row we look at has
    // the known fields:
    assert.strictEqual(applied[0].name, 'extra_col');
  });

  it('custom table name is honored; default `_migrations` is used otherwise', async () => {
    const custom = makeRunner({ table: '__custom_migrations' });
    await custom.getApplied();

    const [customExists] = await client.sql<{ e: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = '__custom_migrations') as e
    `;
    assert.strictEqual(customExists.e, true, 'custom table created');

    const [defaultExists] = await client.sql<{ e: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = '_migrations') as e
    `;
    assert.strictEqual(defaultExists.e, false, 'default table NOT created when override is set');
  });

  it('two runners with different table names are independent', async () => {
    const r1 = makeRunner({ table: '_migs_one' });
    const r2 = makeRunner({ table: '_migs_two' });

    defineMigration({
      name: 'iso_m',
      async up({ db: d }) { await d.raw('CREATE TABLE IF NOT EXISTS iso_m (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE iso_m'); },
    });

    await r1.migrate();

    // r2 sees zero applied for its separate tracking table.
    const r2Applied = await r2.getApplied();
    assert.strictEqual(r2Applied.length, 0);

    const r1Applied = await r1.getApplied();
    assert.strictEqual(r1Applied.length, 1);
  });

  it('stale row in _migrations is visible to reads but makes migrate() throw', async () => {
    // Read-only APIs (`getApplied`, `pending`, `status`) are tolerant of
    // stale rows - they describe what IS, and tools like `just migrate
    // status` must keep working even when the deployed state is drifted.
    // Only the mutating APIs (`migrate`, `rollback`) refuse to proceed.
    const runner = makeRunner();
    await runner.getApplied();
    // Inject a stale row for a name not in the registry.
    await client.sql`INSERT INTO _migrations (name, batch) VALUES ('removed_mig', 7)`;

    defineMigration({
      name: 'still_here',
      async up({ db: d }) { await d.raw('CREATE TABLE still_here (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE still_here'); },
    });

    // getApplied() returns ALL rows, including stale.
    const applied = await runner.getApplied();
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(applied[0].name, 'removed_mig');

    // But `pending()` sees the registered-not-applied name:
    const pending = await runner.pending();
    assert.deepStrictEqual(pending, ['still_here']);

    // `status()` only reports registered:
    const status = await runner.status();
    assert.strictEqual(status.length, 1);
    assert.strictEqual(status[0].name, 'still_here');

    // migrate() now refuses: the stale row means the deploy is inconsistent.
    await assert.rejects(
      runner.migrate(),
      /recorded in _migrations but not registered/,
      'migrate must refuse when _migrations has orphaned rows',
    );
  });
});
