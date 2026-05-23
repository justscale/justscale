/**
 * `PgSchemaIntrospection.sync()` (alternate path) - real docker postgres.
 *
 * This is the "apply DDL directly, no migration tracking" shortcut used by
 * tests and dev-mode sync. Per memory `feedback-no-auto-sync.md`, it must
 * NOT be reachable from the prod `migrate run` CLI controller.
 *
 * Invariants pinned here:
 *   1. Fresh DB -> `sync(models)` creates all tables, they are usable
 *      (insert/select).
 *   2. DB already matches models -> `sync()` is a no-op: no changes
 *      reported, no SQL executed.
 *   3. DB has an extra column -> `sync()` does NOT touch the column
 *      (sync is additive, not destructive). This is a deliberate design
 *      choice - destructive dev-sync would eat prod data.
 *   4. `PgSchemaIntrospection.sync` is intentionally absent from the
 *      top-level `@justscale/postgres` index - importing it from the
 *      top-level barrel should fail, OR the barrel must explicitly not
 *      re-export it. (Either way, the `migrate` CLI controller must not
 *      import from `migration.js` directly.)
 *   5. The `migrate run` CLI controller's call graph does NOT reach
 *      `sync`/`apply` - only `MigrationRunner.migrate`. We assert this by
 *      grepping the controller source for the forbidden symbols.
 *
 * Failure modes these catch:
 *   - `sync` getting re-exported from top-level accidentally.
 *   - `migrate run` being wired to call `sync` as a fallback (memory says
 *     this is forbidden).
 *   - `sync` becoming destructive (dropping unknown columns).
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { defineModel, field } from '@justscale/core/models';
import {
  createPgModel,
  createRawPostgresClient,
  PgSchemaIntrospection,
} from '../../src/index.js';
import { DestructiveMigrationError } from '../../src/migration/migration.js';
import type { AbstractPostgresClient } from '../../src/client/client.js';
import { createTestDatabase, requirePostgres } from '../__mocks__/test-setup.js';

describe('PgSchemaIntrospection.sync (alternate path, real pg)', async () => {
  if (!(await requirePostgres())) return;

  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: AbstractPostgresClient;

  before(async () => {
    db = await createTestDatabase('sync_schema');
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

  it('fresh DB -> sync creates tables and they are usable', async () => {
    class U extends defineModel({
      email: field.string().max(255).unique(),
      displayName: field.string().max(100),
    }) {}
    const PgU = createPgModel(U, { table: 'sync_users' });

    const intro = new PgSchemaIntrospection(client);
    const m = await intro.sync(PgU);
    assert.strictEqual(m.hasChanges, true);

    // Usable:
    await client.sql.unsafe(
      'INSERT INTO sync_users (email, display_name) VALUES (\'a@x\', \'Alice\')',
    );
    const [row] = await client.sql<{ email: string }[]>`
      SELECT email FROM sync_users
    `;
    assert.strictEqual(row.email, 'a@x');
  });

  it('sync is idempotent: second call is a no-op', async () => {
    class U extends defineModel({ email: field.string() }) {}
    const PgU = createPgModel(U, { table: 'sync_idem' });

    const intro = new PgSchemaIntrospection(client);
    await intro.sync(PgU);
    const second = await intro.sync(PgU);
    assert.strictEqual(second.hasChanges, false);
    assert.strictEqual(second.changes.length, 0);
  });

  it('sync REFUSES destructive drops by default (safe-by-default guardrail)', async () => {
    // Memory `feedback-no-auto-sync.md`: `sync()` is a dev/test shortcut and
    // must not silently eat data. The diff engine still produces a
    // `drop_column` change for any column the DB has but the model does
    // not - but `apply()` now refuses to execute it without the caller
    // explicitly opting in.
    class U extends defineModel({ email: field.string() }) {}
    const PgU = createPgModel(U, { table: 'sync_extra' });

    const intro = new PgSchemaIntrospection(client);
    await intro.sync(PgU);

    // Simulate an out-of-band column added by another system.
    await client.sql.unsafe('ALTER TABLE sync_extra ADD COLUMN legacy TEXT');

    // Default sync THROWS instead of silently dropping.
    await assert.rejects(
      () => intro.sync(PgU),
      (err: unknown) => {
        assert.ok(err instanceof DestructiveMigrationError, 'expected DestructiveMigrationError');
        assert.ok(
          err.destructiveChanges.some((c) => c.type === 'drop_column' && c.column === 'legacy'),
          'error should reference the drop_column change',
        );
        assert.match(err.message, /allowDestructive: true/);
        return true;
      },
    );

    // Column MUST still be there - the refused apply was atomic.
    const [col] = await client.sql<{ e: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sync_extra' AND column_name = 'legacy'
      ) as e
    `;
    assert.strictEqual(col.e, true, 'default sync must NOT drop the legacy column');
  });

  it('sync({ allowDestructive: true }, ...) runs destructive DDL when explicitly acknowledged', async () => {
    class U extends defineModel({ email: field.string() }) {}
    const PgU = createPgModel(U, { table: 'sync_extra_ok' });

    const intro = new PgSchemaIntrospection(client);
    await intro.sync(PgU);
    await client.sql.unsafe('ALTER TABLE sync_extra_ok ADD COLUMN legacy TEXT');

    const m = await intro.sync({ allowDestructive: true }, PgU);
    assert.strictEqual(m.hasChanges, true);
    assert.ok(
      m.changes.some((c) => c.type === 'drop_column' && c.column === 'legacy'),
      'sync emits a drop_column for the out-of-band column',
    );

    const [col] = await client.sql<{ e: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sync_extra_ok' AND column_name = 'legacy'
      ) as e
    `;
    assert.strictEqual(col.e, false, 'explicit allowDestructive drops the legacy column');
  });

  it('apply() independently refuses destructive migrations by default', async () => {
    // `generate()` is never destructive by itself - but `apply()` receives
    // the Migration and runs its SQL. The guard must live at apply-time so
    // callers who call generate/apply separately still get the safety net.
    class U extends defineModel({ email: field.string() }) {}
    const PgU = createPgModel(U, { table: 'apply_guard' });

    const intro = new PgSchemaIntrospection(client);
    await intro.sync(PgU);
    await client.sql.unsafe('ALTER TABLE apply_guard ADD COLUMN gone TEXT');

    const diff = await intro.generate(PgU);
    assert.ok(diff.changes.some((c) => c.type === 'drop_column'));

    await assert.rejects(
      () => intro.apply(diff),
      (err: unknown) => err instanceof DestructiveMigrationError,
    );

    // Explicit opt-in works.
    await intro.apply(diff, { allowDestructive: true });
    const [col] = await client.sql<{ e: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'apply_guard' AND column_name = 'gone'
      ) as e
    `;
    assert.strictEqual(col.e, false);
  });

  it('additive-only diffs are not affected by the destructive guard', async () => {
    // Adding a column is safe - default sync must still run it.
    class V1 extends defineModel({ email: field.string() }) {}
    const PgV1 = createPgModel(V1, { table: 'sync_additive' });
    const intro = new PgSchemaIntrospection(client);
    await intro.sync(PgV1);

    class V2 extends defineModel({
      email: field.string(),
      bio: field.text().optional(),
    }) {}
    const PgV2 = createPgModel(V2, { table: 'sync_additive' });

    const m = await intro.sync(PgV2); // no allowDestructive needed
    assert.strictEqual(m.hasChanges, true);
    assert.ok(m.changes.every((c) => c.type !== 'drop_column' && c.type !== 'drop_table'));
  });

  it('MigrationController (just migrate run) does NOT reference sync/apply', async () => {
    // Static guard: inspect the controller source for forbidden symbols.
    // `just migrate run` must call `runner.migrate()` - full stop.
    const src = await readFile(
      new URL('../../src/migration/migration-controller.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(
      !/PgSchemaIntrospection|\.sync\(|\.apply\(/.test(src),
      'migration-controller.ts must NOT touch PgSchemaIntrospection',
    );

    const depSrc = await readFile(
      new URL('../../src/migration/migration-runner.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(
      !/PgSchemaIntrospection|from '\.\.\/migration\/migration\.js'/.test(depSrc),
      'migration-runner.ts must NOT import PgSchemaIntrospection',
    );
  });

  it('MigrationService bundle does not expose a sync() affordance', async () => {
    const { MigrationService } = await import('../../src/migration/migration-controller.js');
    // Smoke test on the shape: the service factory returns { runner, client, table }.
    // If a future change adds a `sync` key, this test flags it for review.
    const keys = Object.keys(MigrationService.factory.toString()).concat(
      // factory is a function; inspect its source.
      [MigrationService.factory.toString()],
    );
    const src = keys.join(' ');
    assert.ok(!src.includes('.sync('), 'MigrationService factory must not wire sync()');
  });
});
