/**
 * MigrationRunner failure + recovery - real docker postgres.
 *
 * Invariants pinned here (the current framework wraps the WHOLE `migrate()`
 * in one transaction, so per-migration atomicity is actually per-batch
 * atomicity):
 *
 *   1. `up()` throws -> NO `_migrations` row written for the failing
 *      migration AND none written for the successfully-completed
 *      migrations earlier in the same batch. The outer transaction
 *      rolls back.
 *   2. Because the failure rolls back the outer tx, DDL done in earlier
 *      migrations of the same batch is ALSO rolled back. (PostgreSQL
 *      supports transactional DDL - this is a feature, not a bug.)
 *   3. Next `migrate()` call after a failure -> re-runs the full batch
 *      from the start (no failed-migration marker to skip it).
 *   4. `fresh()` recovers from any consistent partial state by dropping
 *      everything and re-applying.
 *   5. A throw in `down()` during rollback -> rollback rolls back (outer
 *      transaction aborts), and the applied row is NOT removed.
 *   6. An error during `down()` doesn't corrupt subsequent rollbacks:
 *      after fixing the down(), rollback succeeds cleanly.
 *
 * Failure modes these catch:
 *   - A regression that wraps each `up()` in its own transaction would
 *     make point 2 fail silently, and could leave the DB half-migrated.
 *   - Recording the `_migrations` row before `up()` finishes - would
 *     cause a failed migration to appear applied.
 *   - Retry logic that skips a failed migration.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import {
  clearRegisteredMigrations,
  createMigrationRunner,
  createPostgresLockProvider,
  defineMigration,
} from '../../src/index.js';
import { createRawPostgresClient } from '../../src/client/client.js';
import type { AbstractPostgresClient } from '../../src/client/client.js';
import { createTestDatabase, requirePostgres } from '../__mocks__/test-setup.js';

describe('MigrationRunner failure + recovery (real pg)', async () => {
  if (!(await requirePostgres())) return;

  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: AbstractPostgresClient;
  let lockProvider: ReturnType<typeof createPostgresLockProvider>;

  before(async () => {
    db = await createTestDatabase('runner_failure');
    client = createRawPostgresClient({ connectionString: db.connectionString });
    lockProvider = createPostgresLockProvider(client);
  });

  after(async () => {
    await lockProvider.close();
    await client.close();
    await db.drop();
  });

  function makeRunner() {
    return createMigrationRunner(client, { lockProvider });
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

  it('up() throws -> no _migrations row, earlier successful migrations in batch also rolled back', async () => {
    defineMigration({
      name: 'fail_a',
      async up({ db: d }) {
        await d.raw('CREATE TABLE fail_a (id INT)');
      },
      async down({ db: d }) { await d.raw('DROP TABLE fail_a'); },
    });
    defineMigration({
      name: 'fail_b',
      async up() {
        throw new Error('boom');
      },
      async down() {},
    });

    const runner = makeRunner();
    await assert.rejects(runner.migrate(), /boom/);

    // Advisory-lock transaction rolled back -> _migrations table exists
    // (created by init() outside the tx) but no rows present.
    const applied = await runner.getApplied();
    assert.strictEqual(applied.length, 0, 'no migrations recorded after a failed batch');

    // fail_a's DDL was also rolled back because DDL in postgres is
    // transactional. The table must NOT exist.
    const [r] = await client.sql<{ e: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'fail_a') as e
    `;
    assert.strictEqual(r.e, false, 'earlier migration DDL rolled back with the batch');
  });

  it('subsequent migrate() re-runs the entire batch from scratch', async () => {
    let aUpCount = 0;
    let bUpCount = 0;

    defineMigration({
      name: 'retry_a',
      async up({ db: d }) {
        aUpCount++;
        await d.raw('CREATE TABLE retry_a (id INT)');
      },
      async down({ db: d }) { await d.raw('DROP TABLE retry_a'); },
    });
    defineMigration({
      name: 'retry_b',
      async up() {
        bUpCount++;
        if (bUpCount === 1) throw new Error('first-attempt fail');
      },
      async down() {},
    });

    const runner = makeRunner();
    await assert.rejects(runner.migrate(), /first-attempt fail/);
    assert.strictEqual(aUpCount, 1);
    assert.strictEqual(bUpCount, 1);

    // Retry - should run BOTH migrations again.
    const ran = await runner.migrate();
    assert.deepStrictEqual(ran, ['retry_a', 'retry_b']);
    assert.strictEqual(aUpCount, 2, 'retry_a re-runs from scratch');
    assert.strictEqual(bUpCount, 2, 'retry_b re-runs');
  });

  it('fresh() recovers from an arbitrary interrupted state', async () => {
    // Simulate a weird partial state where the DB has a stray table that a
    // previous migration created but the _migrations row never landed
    // (this can only happen if someone ran DDL outside the runner - fresh
    // should still work because it drops the _migrations table's rows and
    // re-runs up() for everything).
    await client.sql.unsafe('CREATE TABLE stray (id INT)');

    defineMigration({
      name: 'f_recover',
      async up({ db: d }) {
        // Use IF NOT EXISTS so the up() is idempotent - without that,
        // fresh() would hit a name collision with the stray table.
        await d.raw('CREATE TABLE IF NOT EXISTS f_recover (id INT)');
      },
      async down({ db: d }) { await d.raw('DROP TABLE f_recover'); },
    });

    const runner = makeRunner();
    const ran = await runner.fresh();
    assert.deepStrictEqual(ran, ['f_recover']);
  });

  it('throw in down() -> rollback fails, row stays', async () => {
    defineMigration({
      name: 'down_fail',
      async up({ db: d }) { await d.raw('CREATE TABLE down_fail (id INT)'); },
      async down() {
        throw new Error('down boom');
      },
    });

    const runner = makeRunner();
    await runner.migrate();

    await assert.rejects(runner.rollback(), /down boom/);

    // Row must still be there - the rollback was transactional, so the
    // record removal was also rolled back.
    const applied = await runner.getApplied();
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(applied[0].name, 'down_fail');
  });

  it('a fixed down() lets rollback proceed cleanly', async () => {
    let attempts = 0;
    defineMigration({
      name: 'fix_down',
      async up({ db: d }) { await d.raw('CREATE TABLE fix_down (id INT)'); },
      async down({ db: d }) {
        attempts++;
        if (attempts === 1) throw new Error('first-attempt down fail');
        await d.raw('DROP TABLE fix_down');
      },
    });

    const runner = makeRunner();
    await runner.migrate();
    await assert.rejects(runner.rollback(), /first-attempt down fail/);
    const rolled = await runner.rollback();
    assert.deepStrictEqual(rolled, ['fix_down']);
    assert.strictEqual(attempts, 2);
  });

  // Scaling pin: a long batch with a mid-batch failure must roll back
  // the ENTIRE batch — not just the failing migration. Users will
  // reason about this when planning 5+ step migrations and need the
  // guarantee that none of the earlier ones leak DDL or data.
  it('5-migration batch with 3rd failing -> all 5 rolled back, no data leaks', async () => {
    defineMigration({
      name: 'm1',
      async up({ db: d }) { await d.raw('CREATE TABLE m1_table (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE m1_table'); },
    });
    defineMigration({
      name: 'm2',
      async up({ db: d }) {
        await d.raw('CREATE TABLE m2_table (val TEXT)');
        // Critical: data INSERT inside a migration must also be
        // covered by the batch transaction. Without that, "data leaks
        // even though DDL rolled back" is a real footgun.
        await d.raw("INSERT INTO m2_table VALUES ('seed-data')");
      },
      async down({ db: d }) { await d.raw('DROP TABLE m2_table'); },
    });
    defineMigration({
      name: 'm3_fails',
      async up() {
        throw new Error('m3-failure');
      },
      async down() {},
    });
    defineMigration({
      name: 'm4',
      async up({ db: d }) { await d.raw('CREATE TABLE m4_table (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE m4_table'); },
    });
    defineMigration({
      name: 'm5',
      async up({ db: d }) { await d.raw('CREATE TABLE m5_table (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE m5_table'); },
    });

    const runner = makeRunner();
    await assert.rejects(runner.migrate(), /m3-failure/);

    // _migrations table is empty (init() created it outside the tx, so
    // the table exists but no rows).
    const applied = await runner.getApplied();
    assert.strictEqual(applied.length, 0, 'no rows recorded after batch failure');

    // None of the m1/m2/m4/m5 tables should exist.
    for (const t of ['m1_table', 'm2_table', 'm4_table', 'm5_table']) {
      const [r] = await client.sql<{ e: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = ${t}) as e
      `;
      assert.strictEqual(r.e, false, `${t} should not exist after batch rollback`);
    }
  });
});
