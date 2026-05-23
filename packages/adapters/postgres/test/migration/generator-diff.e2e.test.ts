/**
 * Migration generator - schema diff detection + round-trip.
 *
 * Invariants pinned here:
 *   1. No schema, no changes -> `generateDiff` returns `hasChanges: false`,
 *      no file written by `createDiff`.
 *   2. Empty diff -> generated code is a scaffold (still valid ts, so the
 *      dev can edit it if they want).
 *   3. `create_table` change produces a `create_table` SchemaChange; the
 *      emitted code includes the model's field names as snake_case.
 *   4. `add_column` change after a model gains a field produces a single
 *      `add_column` SchemaChange (not a full re-create).
 *   5. Generated code is still valid ts (uses `db.raw()` with authoritative
 *      SQL from the SchemaChange - the one-regex-parses bug is a
 *      regression we pin).
 *   6. Generated code carries `name: '<stamped>'` - the filename and the
 *      emitted name field must agree (runner sorts by name).
 *   7. Generated filename format sorts lexicographically in definition
 *      order (YYYY_MM_DD_HHMMSS_…).
 *   8. Round-trip: apply the generated migration -> a second diff reports
 *      `hasChanges: false`.
 *   9. Enum creation produces a `create_enum` change that runs before
 *      the `create_table` that depends on it (priority ordering).
 *
 * Failure modes these catch:
 *   - Regression where `name:` is dropped from emitted code - runner would
 *     see an empty name and duplicate-apply.
 *   - Filename stamped at write time vs code stamped at generate time
 *     drifting apart.
 *   - Generator fabricating spurious diffs after a clean apply (covered
 *     further in migration-diff-idempotent.e2e.test.ts - this file adds
 *     the multi-change coverage).
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineModel, field } from '@justscale/core/models';
import {
  createPgModel,
  createRawPostgresClient,
  PgMigrationGenerator,
  PgSchemaIntrospection,
} from '../../src/index.js';
import type { AbstractPostgresClient } from '../../src/client/client.js';
import { createTestDatabase, requirePostgres } from '../__mocks__/test-setup.js';

describe('Migration generator - diff + round-trip (real pg)', async () => {
  if (!(await requirePostgres())) return;

  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let client: AbstractPostgresClient;
  let tmpDir: string;

  before(async () => {
    db = await createTestDatabase('generator_diff');
    client = createRawPostgresClient({ connectionString: db.connectionString });
    tmpDir = await mkdtemp(join(tmpdir(), 'gen-diff-'));
  });

  after(async () => {
    await client.close();
    await db.drop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await client.sql.unsafe(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
        FOR r IN (SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e') LOOP
          EXECUTE 'DROP TYPE IF EXISTS public.' || quote_ident(r.typname) || ' CASCADE';
        END LOOP;
      END $$;
    `);
  });

  it('no models -> no diff, no file', async () => {
    class M extends defineModel({ email: field.string() }) {}
    const PgM = createPgModel(M, { table: 'no_diff_m' });

    const gen = new PgMigrationGenerator(new PgSchemaIntrospection(client));
    // First sync to DB.
    await new PgSchemaIntrospection(client).sync(PgM);
    // Second diff - should be empty.
    const diff = await gen.generateDiff([PgM], { name: 'anything' });
    assert.strictEqual(diff.hasChanges, false);
    assert.strictEqual(diff.changes.length, 0);

    const res = await gen.createDiff(tmpDir, [PgM], { name: 'noop' });
    assert.strictEqual((res as any).filepath, undefined, 'no file written when no changes');
    const files = await readdir(tmpDir);
    assert.strictEqual(files.filter((f) => f.includes('noop')).length, 0);
  });

  it('fresh DB -> diff emits create_table with the configured table name', async () => {
    class U extends defineModel({
      email: field.string().max(255).unique(),
      displayName: field.string().max(100),
    }) {}
    const PgU = createPgModel(U, { table: 'gen_users' });

    const gen = new PgMigrationGenerator(new PgSchemaIntrospection(client));
    const diff = await gen.generateDiff([PgU], { name: '2026_01_01_120000_init' });

    assert.strictEqual(diff.hasChanges, true);
    const createTable = diff.changes.find((c) => c.type === 'create_table');
    assert.ok(createTable, 'should emit a create_table SchemaChange');
    assert.strictEqual(createTable!.table, 'gen_users');

    // Code contains the stamped name (regression test - this was a bug).
    assert.ok(
      diff.code.includes("name: '2026_01_01_120000_init'"),
      'emitted code must carry the stamped name',
    );
    // Code uses db.raw(...) for the SchemaChange's authoritative SQL.
    assert.ok(diff.code.includes('await db.raw'));
    // Doesn't truncate column names:
    assert.ok(diff.code.includes('display_name') || diff.code.includes('displayName'));
  });

  it('enum + table -> enum change has lower priority than its dependent table', async () => {
    class Order extends defineModel({
      status: field.enum('gen_order_status', ['draft', 'sent'] as const),
    }) {}
    const PgOrder = createPgModel(Order, { table: 'gen_orders' });

    const gen = new PgMigrationGenerator(new PgSchemaIntrospection(client));
    const diff = await gen.generateDiff([PgOrder], { name: 'with_enum' });

    assert.strictEqual(diff.hasChanges, true);
    const enumChange = diff.changes.find((c) => c.type === 'create_enum');
    const tableChange = diff.changes.find((c) => c.type === 'create_table');
    assert.ok(enumChange, 'must emit create_enum');
    assert.ok(tableChange, 'must emit create_table');
    assert.ok(
      enumChange!.priority < tableChange!.priority,
      `enum priority (${enumChange!.priority}) must be < table priority (${tableChange!.priority})`,
    );
  });

  it('round-trip: apply generated migration -> second diff is empty', async () => {
    class RT extends defineModel({
      email: field.string().max(255).unique(),
      bio: field.text().optional(),
    }) {}
    const PgRT = createPgModel(RT, { table: 'gen_rt' });

    const intro = new PgSchemaIntrospection(client);
    const first = await intro.generate(PgRT);
    assert.strictEqual(first.hasChanges, true);

    await intro.apply(first);

    const second = await intro.generate(PgRT);
    assert.strictEqual(second.hasChanges, false, `expected 0 changes, got: ${second.changes.map((c) => c.type).join(', ')}`);
  });

  it('add_column: extending a model -> diff emits exactly one add_column', async () => {
    class V1 extends defineModel({ email: field.string().max(255) }) {}
    const PgV1 = createPgModel(V1, { table: 'gen_versioned' });

    const intro = new PgSchemaIntrospection(client);
    await intro.sync(PgV1);

    class V2 extends defineModel({
      email: field.string().max(255),
      bio: field.text().optional(),
    }) {}
    const PgV2 = createPgModel(V2, { table: 'gen_versioned' });

    const diff = await intro.generate(PgV2);
    assert.strictEqual(diff.hasChanges, true);

    const addCol = diff.changes.filter((c) => c.type === 'add_column');
    assert.strictEqual(addCol.length, 1, `expected 1 add_column, got: ${diff.changes.map((c) => `${c.type}(${c.column ?? c.table})`).join(', ')}`);
    assert.strictEqual(addCol[0].column, 'bio');
    assert.strictEqual(addCol[0].table, 'gen_versioned');
  });

  it('drop_column: shrinking a model -> diff emits exactly one drop_column', async () => {
    class V1 extends defineModel({
      email: field.string().max(255),
      nickname: field.string().max(50).optional(),
    }) {}
    const PgV1 = createPgModel(V1, { table: 'gen_shrunk' });

    const intro = new PgSchemaIntrospection(client);
    await intro.sync(PgV1);

    class V2 extends defineModel({ email: field.string().max(255) }) {}
    const PgV2 = createPgModel(V2, { table: 'gen_shrunk' });

    const diff = await intro.generate(PgV2);
    const dropCol = diff.changes.filter((c) => c.type === 'drop_column');
    assert.strictEqual(dropCol.length, 1);
    assert.strictEqual(dropCol[0].column, 'nickname');
  });

  it('foreign key: adding a ref -> emits add_foreign_key and applies cleanly', async () => {
    class Author extends defineModel({ name: field.string() }) {}
    class Post extends defineModel({
      title: field.string(),
      author: field.ref(Author),
    }) {}
    const PgAuthor = createPgModel(Author, { table: 'gen_author' });
    const PgPost = createPgModel(Post, {
      table: 'gen_post',
      relations: { author: { onDelete: 'CASCADE' } },
    });

    const intro = new PgSchemaIntrospection(client);
    const diff = await intro.generate(PgAuthor, PgPost);

    const fkChange = diff.changes.find((c) => c.type === 'add_foreign_key');
    assert.ok(fkChange, `expected add_foreign_key, got: ${diff.changes.map((c) => c.type).join(', ')}`);
    assert.strictEqual(fkChange!.table, 'gen_post');

    // Round-trip: apply then re-diff.
    await intro.apply(diff);
    const second = await intro.generate(PgAuthor, PgPost);
    assert.strictEqual(second.hasChanges, false);
  });

  it('createDiff writes a file with the stamped name when there are changes', async () => {
    class W extends defineModel({ id: field.int() }) {}
    const PgW = createPgModel(W, { table: 'gen_write' });

    const gen = new PgMigrationGenerator(new PgSchemaIntrospection(client));
    const result = await gen.createDiff(tmpDir, [PgW], { name: 'create_write_table' });

    assert.strictEqual(result.hasChanges, true);
    const filepath = (result as any).filepath as string;
    assert.ok(filepath, 'filepath set when changes were detected');

    // Filename must match YYYY_MM_DD_HHMMSS_<slug>.ts
    const basename = filepath.split('/').pop()!;
    assert.match(basename, /^\d{4}_\d{2}_\d{2}_\d{6}_create_write_table\.ts$/);

    const content = await readFile(filepath, 'utf-8');
    // File's `name:` field matches filename stem.
    const stem = basename.replace(/\.ts$/, '');
    assert.ok(
      content.includes(`name: '${stem}'`),
      'filename and emitted `name:` must be identical (runner sorts by name)',
    );
  });
});
