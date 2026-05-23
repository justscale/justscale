/**
 * MigrationRunner basic correctness - real docker postgres.
 *
 * Invariants pinned here (each `it` names one):
 *   1. Fresh DB + one pending -> `migrate()` applies, `_migrations` row written,
 *      `batch=1`, `name` == the registered name.
 *   2. Second `migrate()` is a no-op: the run returns `[]`, row count unchanged.
 *   3. `rollback()` on last batch: runs the last-batch migrations' `down()`
 *      in reverse of application, removes rows, batch counter drops.
 *   4. `rollback()` when nothing is applied -> `[]`, no error.
 *   5. `reset()` rolls back every batch, in reverse batch order.
 *   6. `fresh()` = reset + migrate, i.e. net-zero-then-all-applied.
 *   7. Multiple pending migrations applied in the same call share a batch
 *      number (so a single rollback undoes them as a unit).
 *   8. Across multiple `migrate()` calls with new pending each time, the
 *      batch number increments by 1 per call.
 *   9. Order: runner sorts registered migrations by name lexicographically,
 *      NOT by registration order.
 *   10. `status()` lists all registered, with `applied` flipped for each.
 *   11. `pending()` lists only unapplied, in name-sorted order.
 *   12. `run(name)` applies a single named migration out-of-band, returns true
 *       on first apply, false when already applied.
 *
 * Failure modes these catch:
 *   - Runner loses migrations between migrate/rollback (off-by-one in batch).
 *   - Up/down called more than once for the same migration.
 *   - Rollback order wrong (would break real migrations that drop FK before
 *     parent table).
 *   - Runner silently drops migrations not in the applied set on rollback.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import {
  clearRegisteredMigrations,
  createMigrationRunner,
  createPostgresLockProvider,
  createRawPostgresClient,
  defineMigration,
  getRegisteredMigrations,
} from '../../src/index.js';
import type { AbstractPostgresClient } from '../../src/client/client.js';
import { createTestDatabase, requirePostgres } from '../__mocks__/test-setup.js';

describe('MigrationRunner basic correctness (real pg)', async () => {
  if (!(await requirePostgres())) return;

  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: AbstractPostgresClient;
  let lockProvider: ReturnType<typeof createPostgresLockProvider>;

  before(async () => {
    db = await createTestDatabase('runner_basic');
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
    // Wipe any tracking + test tables from a prior test
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

  it('fresh DB + 1 pending -> migrate applies, record written', async () => {
    defineMigration({
      name: '2026_01_01_000000_create_foo',
      async up({ db: d }) {
        await d.raw('CREATE TABLE foo (id SERIAL PRIMARY KEY)');
      },
      async down({ db: d }) {
        await d.raw('DROP TABLE foo');
      },
    });

    const runner = makeRunner();
    const ran = await runner.migrate();
    assert.deepStrictEqual(ran, ['2026_01_01_000000_create_foo']);

    const applied = await runner.getApplied();
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(applied[0].name, '2026_01_01_000000_create_foo');
    assert.strictEqual(applied[0].batch, 1);

    // And the migration actually ran:
    const [exists] = await client.sql<{ e: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'foo') as e
    `;
    assert.strictEqual(exists.e, true);
  });

  it('second migrate() on an up-to-date DB is a no-op', async () => {
    defineMigration({
      name: 'mig_a',
      async up({ db: d }) { await d.raw('CREATE TABLE a (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE a'); },
    });

    const runner = makeRunner();
    const first = await runner.migrate();
    const second = await runner.migrate();

    assert.deepStrictEqual(first, ['mig_a']);
    assert.deepStrictEqual(second, [], 'second migrate must report nothing ran');

    // Row count must also be unchanged.
    const applied = await runner.getApplied();
    assert.strictEqual(applied.length, 1);
  });

  it('rollback runs down() in reverse of applied order and removes rows', async () => {
    // Register in a specific order - but the runner will sort by name.
    defineMigration({
      name: 'mig_02',
      async up({ db: d }) { await d.raw('CREATE TABLE t2 (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE t2'); },
    });
    defineMigration({
      name: 'mig_01',
      async up({ db: d }) { await d.raw('CREATE TABLE t1 (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE t1'); },
    });

    const runner = makeRunner();
    await runner.migrate();

    // Track down() call order with a sentinel.
    const calls: string[] = [];
    // Replace the registered ones with instrumented versions (same names).
    clearRegisteredMigrations();
    defineMigration({
      name: 'mig_01',
      async up() {},
      async down({ db: d }) {
        calls.push('mig_01');
        await d.raw('DROP TABLE t1');
      },
    });
    defineMigration({
      name: 'mig_02',
      async up() {},
      async down({ db: d }) {
        calls.push('mig_02');
        await d.raw('DROP TABLE t2');
      },
    });

    const rolledBack = await runner.rollback();
    assert.deepStrictEqual(
      rolledBack,
      ['mig_02', 'mig_01'],
      'rollback returns in reverse application order',
    );
    assert.deepStrictEqual(calls, ['mig_02', 'mig_01'], 'down() called in reverse');

    // Both rows gone.
    const applied = await runner.getApplied();
    assert.strictEqual(applied.length, 0);

    // And the tables truly gone.
    const [r] = await client.sql<{ n: number }[]>`
      SELECT COUNT(*)::int as n FROM pg_tables WHERE tablename IN ('t1', 't2')
    `;
    assert.strictEqual(r.n, 0);
  });

  it('rollback on empty state returns [] without error', async () => {
    const runner = makeRunner();
    const r = await runner.rollback();
    assert.deepStrictEqual(r, []);
  });

  it('multiple pending in one call share a single batch number', async () => {
    defineMigration({
      name: 'p1', async up({ db: d }) { await d.raw('CREATE TABLE p1 (id INT)'); }, async down() {},
    });
    defineMigration({
      name: 'p2', async up({ db: d }) { await d.raw('CREATE TABLE p2 (id INT)'); }, async down() {},
    });
    defineMigration({
      name: 'p3', async up({ db: d }) { await d.raw('CREATE TABLE p3 (id INT)'); }, async down() {},
    });

    const runner = makeRunner();
    await runner.migrate();

    const applied = await runner.getApplied();
    assert.strictEqual(applied.length, 3);
    const batches = new Set(applied.map((m) => m.batch));
    assert.deepStrictEqual([...batches], [1], 'all three must share batch 1');
  });

  it('subsequent migrate() calls increment batch', async () => {
    defineMigration({
      name: 'b_a', async up({ db: d }) { await d.raw('CREATE TABLE b_a (id INT)'); }, async down() {},
    });
    const runner = makeRunner();
    await runner.migrate();

    // Clear the registry and register a new pending migration - simulates a
    // second deploy adding a migration.
    clearRegisteredMigrations();
    defineMigration({
      name: 'b_a',
      async up() { /* already applied, would not re-run */ },
      async down() {},
    });
    defineMigration({
      name: 'b_b',
      async up({ db: d }) { await d.raw('CREATE TABLE b_b (id INT)'); },
      async down() {},
    });

    await runner.migrate();

    const applied = await runner.getApplied();
    const aBatch = applied.find((m) => m.name === 'b_a')!.batch;
    const bBatch = applied.find((m) => m.name === 'b_b')!.batch;
    assert.strictEqual(aBatch, 1);
    assert.strictEqual(bBatch, 2);
  });

  it('runner sorts by name (not by registration order)', async () => {
    const appliedOrder: string[] = [];

    // Registered in z, a, m order. Runner must run them a, m, z.
    defineMigration({
      name: '003_z',
      async up() { appliedOrder.push('003_z'); },
      async down() {},
    });
    defineMigration({
      name: '001_a',
      async up() { appliedOrder.push('001_a'); },
      async down() {},
    });
    defineMigration({
      name: '002_m',
      async up() { appliedOrder.push('002_m'); },
      async down() {},
    });

    const runner = makeRunner();
    const ran = await runner.migrate();
    assert.deepStrictEqual(ran, ['001_a', '002_m', '003_z']);
    assert.deepStrictEqual(appliedOrder, ['001_a', '002_m', '003_z']);
  });

  it('status() reports applied flag + batch for all registered migrations', async () => {
    defineMigration({
      name: 's_a', async up() {}, async down() {},
    });
    defineMigration({
      name: 's_b', async up() {}, async down() {},
    });

    const runner = makeRunner();
    await runner.migrate();

    // Register another after applying.
    defineMigration({
      name: 's_c', async up() {}, async down() {},
    });

    const status = await runner.status();
    assert.strictEqual(status.length, 3);
    const byName = Object.fromEntries(status.map((s) => [s.name, s]));
    assert.strictEqual(byName.s_a.applied, true);
    assert.strictEqual(byName.s_a.batch, 1);
    assert.strictEqual(byName.s_b.applied, true);
    assert.strictEqual(byName.s_c.applied, false);
    assert.strictEqual(byName.s_c.batch, undefined);
  });

  it('pending() returns only unapplied migrations in name-sorted order', async () => {
    defineMigration({ name: 'pend_b', async up() {}, async down() {} });
    const runner = makeRunner();
    await runner.migrate();

    defineMigration({ name: 'pend_c', async up() {}, async down() {} });
    defineMigration({ name: 'pend_a', async up() {}, async down() {} });

    const pending = await runner.pending();
    assert.deepStrictEqual(pending, ['pend_a', 'pend_c']);
  });

  it('reset() rolls back every batch', async () => {
    defineMigration({
      name: 'r_a',
      async up({ db: d }) { await d.raw('CREATE TABLE r_a (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE r_a'); },
    });
    const runner = makeRunner();
    await runner.migrate();

    // Second deploy.
    defineMigration({
      name: 'r_b',
      async up({ db: d }) { await d.raw('CREATE TABLE r_b (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE r_b'); },
    });
    await runner.migrate();

    const beforeReset = await runner.getApplied();
    assert.strictEqual(beforeReset.length, 2);
    const batches = [...new Set(beforeReset.map((m) => m.batch))].sort();
    assert.deepStrictEqual(batches, [1, 2]);

    const rolled = await runner.reset();
    assert.strictEqual(rolled.length, 2);
    assert.strictEqual((await runner.getApplied()).length, 0);
  });

  it('fresh() resets then re-applies everything', async () => {
    defineMigration({
      name: 'f_a',
      async up({ db: d }) { await d.raw('CREATE TABLE f_a (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE f_a'); },
    });
    const runner = makeRunner();
    await runner.migrate();
    // Insert a row so we can see it disappears after fresh.
    await client.sql.unsafe('INSERT INTO f_a (id) VALUES (42)');
    const [{ n: beforeRow }] = await client.sql<{ n: number }[]>`SELECT COUNT(*)::int as n FROM f_a`;
    assert.strictEqual(beforeRow, 1);

    const ran = await runner.fresh();
    assert.deepStrictEqual(ran, ['f_a'], 'fresh reports the migrations re-applied');

    // Table recreated fresh - row gone.
    const [{ n: afterRow }] = await client.sql<{ n: number }[]>`SELECT COUNT(*)::int as n FROM f_a`;
    assert.strictEqual(afterRow, 0);
  });

  it('run(name) applies a single named migration; idempotent on second call', async () => {
    defineMigration({
      name: 'x',
      async up({ db: d }) { await d.raw('CREATE TABLE x (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE x'); },
    });

    const runner = makeRunner();
    const a = await runner.run('x');
    const b = await runner.run('x');
    assert.strictEqual(a, true, 'first call applies');
    assert.strictEqual(b, false, 'second call is a no-op');
  });

  it('run(name) throws when the migration is not registered', async () => {
    const runner = makeRunner();
    await assert.rejects(runner.run('does_not_exist'), /not registered/);
  });

  it('rollback throws when a recorded migration is missing from the registry', async () => {
    defineMigration({
      name: 'ghost',
      async up({ db: d }) { await d.raw('CREATE TABLE ghost (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE ghost'); },
    });
    const runner = makeRunner();
    await runner.migrate();

    // Simulate someone deleting the migration file between deploys.
    clearRegisteredMigrations();

    await assert.rejects(
      runner.rollback(),
      /recorded in _migrations but not registered/,
      'rollback must surface the drift, not silently skip',
    );
  });

  it('stale row in _migrations with no registry entry makes migrate() throw (strict, parity with rollback)', async () => {
    // A row in `_migrations` with no corresponding registered migration is a
    // broken deploy: the source file was renamed or deleted without a
    // compensating migration, so the runner can no longer invert it. We
    // surface the drift at `migrate()` time, mirroring `rollback()`, so the
    // operator fixes the registry before more state piles up on top.
    const runner = makeRunner();
    await runner.migrate(); // creates _migrations

    // Inject a stale row directly.
    await client.sql`INSERT INTO _migrations (name, batch) VALUES ('ghost_from_past', 99)`;

    defineMigration({
      name: 'new_one',
      async up({ db: d }) { await d.raw('CREATE TABLE new_one (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE new_one'); },
    });

    await assert.rejects(
      runner.migrate(),
      /recorded in _migrations but not registered/,
      'migrate must surface the drift, not silently skip',
    );
  });
});
