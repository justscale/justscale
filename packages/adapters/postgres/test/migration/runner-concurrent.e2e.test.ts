/**
 * MigrationRunner advisory-lock / concurrency - real docker postgres.
 *
 * Invariants pinned here:
 *   1. Two runners racing on a fresh DB -> exactly ONE `up()` call per
 *      migration. Never zero, never two. The losing runner sees zero pending
 *      when it finally acquires the lock.
 *   2. N (10) concurrent runners on a fresh DB with 3 migrations -> each
 *      migration runs exactly once across all 10 runners, all converge to the
 *      same post-state.
 *   3. The winning runner's `migrate()` returns the full list of applied
 *      names; the losing runner's returns [] (not a subset).
 *   4. `pg_advisory_xact_lock` is transaction-scoped - after migrate()
 *      returns, the lock is released (verified implicitly by a follow-up
 *      migrate() completing instantly).
 *   5. Many runners racing init() on a brand-new DB never produce SQLSTATE
 *      42710 / 23505 - the advisory lock covers the bootstrap DDL too.
 *
 * Failure modes these catch:
 *   - A race where both runners read "0 applied", both call up(), both
 *     insert the _migrations row -> unique violation OR worse, silent double-
 *     apply if the constraint were ever relaxed.
 *   - Lock held across transactions, deadlocking second runner.
 *   - Runner using a non-transactional lock that doesn't auto-release on
 *     crash.
 *   - init() outside the advisory lock: CREATE TABLE IF NOT EXISTS triggers
 *     an implicit composite-type creation that races in pg_type under
 *     concurrency (SQLSTATE 42710 / 23505).
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
import type { LockProvider } from '@justscale/core';
import { createTestDatabase, requirePostgres } from '../__mocks__/test-setup.js';

describe('MigrationRunner concurrent safety (real pg)', async () => {
  if (!(await requirePostgres())) return;

  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  // Many clients -> distinct pools so each acts like a separate process.
  const clients: AbstractPostgresClient[] = [];
  const lockProviders: LockProvider[] = [];

  before(async () => {
    db = await createTestDatabase('runner_concurrent');
  });

  after(async () => {
    await Promise.all(lockProviders.map((lp) => lp.close()));
    await Promise.all(clients.map((c) => c.close()));
    await db.drop();
  });

  beforeEach(async () => {
    clearRegisteredMigrations();

    // Clean all public tables via an admin client (create new, then close).
    const admin = createRawPostgresClient({ connectionString: db.connectionString });
    await admin.sql.unsafe(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    await admin.close();
  });

  function newClient(): AbstractPostgresClient {
    const c = createRawPostgresClient({ connectionString: db.connectionString });
    clients.push(c);
    return c;
  }

  /**
   * Build a runner with its own client + its own pg-backed lock provider.
   * Distinct lock providers per runner is the realistic shape - each
   * "process" has its own LockProvider instance, all coordinating via the
   * shared advisory lock in postgres.
   */
  function newRunner(client: AbstractPostgresClient = newClient()) {
    const lockProvider = createPostgresLockProvider(client);
    lockProviders.push(lockProvider);
    return createMigrationRunner(client, { lockProvider });
  }

  it('two runners racing on one migration -> exactly one apply', async () => {
    let upCallCount = 0;
    defineMigration({
      name: 'race_m1',
      async up({ db: d }) {
        upCallCount++;
        // Small artificial delay - gives the other runner every chance to
        // race us if the lock is broken.
        await new Promise((r) => setTimeout(r, 50));
        await d.raw('CREATE TABLE race_m1 (id INT)');
      },
      async down({ db: d }) { await d.raw('DROP TABLE race_m1'); },
    });

    const r1 = newRunner();
    const r2 = newRunner();

    const [a, b] = await Promise.all([r1.migrate(), r2.migrate()]);

    assert.strictEqual(upCallCount, 1, 'up() must run exactly once');
    const total = a.length + b.length;
    assert.strictEqual(total, 1, 'exactly one runner reports applying the migration');

    // Whichever ran second must report []:
    const empty = a.length === 0 ? a : b;
    assert.deepStrictEqual(empty, [], 'losing runner reports nothing applied');

    // Row should be present exactly once.
    const admin = newClient();
    const applied = await admin.sql<{ n: number }[]>`SELECT COUNT(*)::int as n FROM _migrations WHERE name = 'race_m1'`;
    assert.strictEqual(applied[0].n, 1);
  });

  it('10 concurrent runners, 3 migrations -> each migration runs exactly once', async () => {
    const upCounts = { a: 0, b: 0, c: 0 };
    defineMigration({
      name: 'ten_a',
      async up({ db: d }) {
        upCounts.a++;
        await d.raw('CREATE TABLE ten_a (id INT)');
      },
      async down({ db: d }) { await d.raw('DROP TABLE ten_a'); },
    });
    defineMigration({
      name: 'ten_b',
      async up({ db: d }) {
        upCounts.b++;
        await d.raw('CREATE TABLE ten_b (id INT)');
      },
      async down({ db: d }) { await d.raw('DROP TABLE ten_b'); },
    });
    defineMigration({
      name: 'ten_c',
      async up({ db: d }) {
        upCounts.c++;
        await d.raw('CREATE TABLE ten_c (id INT)');
      },
      async down({ db: d }) { await d.raw('DROP TABLE ten_c'); },
    });

    const runners = Array.from({ length: 10 }, () => newRunner());
    const results = await Promise.all(runners.map((r) => r.migrate()));

    assert.strictEqual(upCounts.a, 1, 'migration a must run exactly once');
    assert.strictEqual(upCounts.b, 1, 'migration b must run exactly once');
    assert.strictEqual(upCounts.c, 1, 'migration c must run exactly once');

    // Exactly one runner reports the full list; all others report [].
    const nonEmpty = results.filter((r) => r.length > 0);
    assert.strictEqual(nonEmpty.length, 1, 'exactly one runner wins the lock');
    assert.deepStrictEqual(
      nonEmpty[0].sort(),
      ['ten_a', 'ten_b', 'ten_c'],
      'winning runner applies all three',
    );

    // All agree on the state.
    const states = await Promise.all(runners.map((r) => r.getApplied()));
    for (const s of states) {
      assert.strictEqual(s.length, 3);
    }
  });

  it('advisory lock is released after migrate() so the next migrate is not blocked', async () => {
    defineMigration({
      name: 'lock_release_a',
      async up({ db: d }) { await d.raw('CREATE TABLE lock_release_a (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE lock_release_a'); },
    });

    const runner = newRunner();
    await runner.migrate();

    // Register another and run again sequentially - must not block.
    defineMigration({
      name: 'lock_release_b',
      async up({ db: d }) { await d.raw('CREATE TABLE lock_release_b (id INT)'); },
      async down({ db: d }) { await d.raw('DROP TABLE lock_release_b'); },
    });

    const start = Date.now();
    const ran = await runner.migrate();
    const elapsed = Date.now() - start;
    assert.deepStrictEqual(ran, ['lock_release_b']);
    assert.ok(elapsed < 2000, `second migrate should return fast (got ${elapsed}ms)`);
  });

  it('init() is concurrency-safe: N runners racing a brand-new DB never see 42710/23505', async () => {
    // Regression for: init() was called OUTSIDE withMigrationLock, causing
    // CREATE TABLE IF NOT EXISTS to race on the implicit composite-type that
    // Postgres adds to pg_type alongside the table - producing SQLSTATE 42710
    // ("type already exists") or 23505 (unique violation on pg_type_typname_nsp_index)
    // under concurrent first-start. The fix: init() runs inside the advisory
    // lock so only one session ever issues the DDL.
    const trials = 5;
    for (let i = 0; i < trials; i++) {
      // Drop _migrations between trials to keep the race fresh each time.
      // Use a short-lived admin connection so we don't pin pool slots.
      const admin = createRawPostgresClient({ connectionString: db.connectionString });
      await admin.sql.unsafe('DROP TABLE IF EXISTS _migrations CASCADE');

      clearRegisteredMigrations();
      defineMigration({
        name: `race_init_${i}`,
        async up() {},
        async down() {},
      });

      // Each runner gets its own short-lived client + lock provider; close
      // them at the end of the trial so connection pools don't accumulate
      // across trials (pg's max_connections is finite).
      const trialClients = Array.from({ length: 5 }, () =>
        createRawPostgresClient({ connectionString: db.connectionString }),
      );
      const trialLockProviders = trialClients.map((c) => createPostgresLockProvider(c));
      const runners = trialClients.map((c, idx) =>
        createMigrationRunner(c, { lockProvider: trialLockProviders[idx] }),
      );

      try {
        // Must not throw at all - any error here is a bug.
        await Promise.all(runners.map((r) => r.migrate()));

        // Table must exist and have exactly one row.
        const rows = await admin.sql<{ n: number }[]>`SELECT COUNT(*)::int as n FROM _migrations`;
        assert.strictEqual(rows[0].n, 1, `trial ${i}: expected exactly 1 migration row`);
      } finally {
        await Promise.all(trialLockProviders.map((lp) => lp.close()));
        await Promise.all(trialClients.map((c) => c.close()));
        await admin.close();
      }
    }
  });

  it('LockProvider-based bootstrap race: two runners on a fresh DB serialise the CREATE TABLE', async () => {
    // Pins the abstract LockProvider integration: even though the runner now
    // talks to AbstractLockProvider rather than emitting pg_advisory_lock SQL
    // inline, two runners on a brand-new DB must still serialise the
    // _migrations bootstrap. Exactly one runner wins the CREATE TABLE; both
    // converge to the same post-state with the row count we expect.
    //
    // Regression target: a future refactor that drops the lock or routes it
    // through a no-op provider would let the pg_type catalog race fire
    // (SQLSTATE 42710 / 23505), which this test would catch.
    const trials = 5;
    for (let i = 0; i < trials; i++) {
      // Short-lived clients per trial so we don't pin pool slots between
      // iterations. pg's max_connections is finite.
      const admin = createRawPostgresClient({ connectionString: db.connectionString });
      await admin.sql.unsafe('DROP TABLE IF EXISTS _migrations CASCADE');

      clearRegisteredMigrations();
      let upCount = 0;
      defineMigration({
        name: `lp_race_${i}`,
        async up() { upCount++; },
        async down() {},
      });

      // Two distinct clients + lock providers - realistic shape for two app
      // instances coordinating via pg.
      const c1 = createRawPostgresClient({ connectionString: db.connectionString });
      const c2 = createRawPostgresClient({ connectionString: db.connectionString });
      const lp1 = createPostgresLockProvider(c1);
      const lp2 = createPostgresLockProvider(c2);
      const r1 = createMigrationRunner(c1, { lockProvider: lp1 });
      const r2 = createMigrationRunner(c2, { lockProvider: lp2 });

      try {
        const [a, b] = await Promise.all([r1.migrate(), r2.migrate()]);

        assert.strictEqual(upCount, 1, `trial ${i}: up() must run exactly once`);
        assert.strictEqual(
          a.length + b.length,
          1,
          `trial ${i}: exactly one runner reports the migration applied`,
        );

        const rows = await admin.sql<{ n: number }[]>`SELECT COUNT(*)::int as n FROM _migrations`;
        assert.strictEqual(rows[0].n, 1, `trial ${i}: exactly one _migrations row`);

        // Both runners agree on the final state.
        const [s1, s2] = await Promise.all([r1.getApplied(), r2.getApplied()]);
        assert.strictEqual(s1.length, 1);
        assert.strictEqual(s2.length, 1);
        assert.strictEqual(s1[0].name, `lp_race_${i}`);
        assert.strictEqual(s2[0].name, `lp_race_${i}`);
      } finally {
        await Promise.all([lp1.close(), lp2.close()]);
        await Promise.all([c1.close(), c2.close()]);
        await admin.close();
      }
    }
  });

  it('concurrent rollback - only one runner reverses the last batch', async () => {
    let downCallCount = 0;
    defineMigration({
      name: 'roll_one',
      async up({ db: d }) { await d.raw('CREATE TABLE roll_one (id INT)'); },
      async down({ db: d }) {
        downCallCount++;
        await d.raw('DROP TABLE roll_one');
      },
    });

    // Apply once.
    const setup = newRunner();
    await setup.migrate();

    const r1 = newRunner();
    const r2 = newRunner();
    const [a, b] = await Promise.all([r1.rollback(), r2.rollback()]);

    assert.strictEqual(downCallCount, 1, 'down() called exactly once');
    const total = a.length + b.length;
    assert.strictEqual(total, 1);
  });
});
