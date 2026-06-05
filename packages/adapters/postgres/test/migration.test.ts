import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { defineModel, field } from '@justscale/core/models';
import {
  createPgModel,
  diffSchema,
  createMigrationDatabase,
  PgSchemaIntrospection,
} from '../src/index.js';
import { createRawPostgresClient } from '../src/client/client.js';
import type { AbstractPostgresClient } from '../src/client/client.js';
import type { Database } from '../src/migration/migration-schema.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

const TEST_TABLE = 'migration_test_users';

describe('Migration System', async () => {
  if (!await requirePostgres()) return;

  let client: AbstractPostgresClient;

  class User extends defineModel({
    email: field.string().max(255).unique(),
    name: field.string(),
    age: field.int().optional(),
  }) {}

  const PgUser = createPgModel(User, {
    table: TEST_TABLE,
  });

  before(async () => {
    client = createRawPostgresClient({
      connectionString: CONNECTION_STRING,
    });

    // Clean up any leftover test table
    await client.sql.unsafe(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
  });

  after(async () => {
    // Clean up
    await client.sql.unsafe(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
    await client.close();
  });

  it('should detect table creation needed', async () => {
    const migration = await new PgSchemaIntrospection(client).generate(PgUser);

    assert.strictEqual(migration.hasChanges, true);
    assert.ok(migration.changes.length > 0);
    assert.strictEqual(migration.changes[0].type, 'create_table');
    assert.ok(migration.sql.includes('CREATE TABLE'));
  });

  it('should create table via syncSchema', async () => {
    const migration = await new PgSchemaIntrospection(client).sync(PgUser);

    assert.strictEqual(migration.hasChanges, true);

    // Verify table exists
    const schema = await new PgSchemaIntrospection(client).tableSchema(TEST_TABLE);
    assert.ok(schema !== null);
    assert.strictEqual(schema.tableName, TEST_TABLE);

    // Check columns exist
    const columnNames = schema.columns.map((c) => c.columnName);
    assert.ok(columnNames.includes('id'));
    assert.ok(columnNames.includes('email'));
    assert.ok(columnNames.includes('name'));
    assert.ok(columnNames.includes('age'));
    assert.ok(columnNames.includes('created_at'));
    assert.ok(columnNames.includes('updated_at'));
    assert.ok(columnNames.includes('version'));
  });

  it('should report no changes when schema matches', async () => {
    const migration = await new PgSchemaIntrospection(client).generate(PgUser);

    assert.strictEqual(migration.hasChanges, false);
    assert.strictEqual(migration.changes.length, 0);
  });

  it('should detect new column needed', async () => {
    // Create a model with an additional field
    class UserV2 extends defineModel({
      email: field.string().max(255).unique(),
      name: field.string(),
      age: field.int().optional(),
      bio: field.text().optional(), // New field
    }) {}

    const PgUserV2 = createPgModel(UserV2, {
      table: TEST_TABLE,
    });

    const migration = await new PgSchemaIntrospection(client).generate(PgUserV2);

    assert.strictEqual(migration.hasChanges, true);

    const addColumnChange = migration.changes.find(
      (c) => c.type === 'add_column' && c.column === 'bio',
    );
    assert.ok(addColumnChange, 'Should detect bio column addition');
    assert.ok(addColumnChange.sql.includes('ADD COLUMN bio'));
  });

  it('should detect column removal', async () => {
    // Create a model without the age field
    class UserV3 extends defineModel({
      email: field.string().max(255).unique(),
      name: field.string(),
      // age removed
    }) {}

    const PgUserV3 = createPgModel(UserV3, {
      table: TEST_TABLE,
    });

    const migration = await new PgSchemaIntrospection(client).generate(PgUserV3);

    assert.strictEqual(migration.hasChanges, true);

    const dropColumnChange = migration.changes.find(
      (c) => c.type === 'drop_column' && c.column === 'age',
    );
    assert.ok(dropColumnChange, 'Should detect age column removal');
    assert.ok(dropColumnChange.sql.includes('DROP COLUMN age'));
  });

  it('should use diffSchema directly', async () => {
    const config = PgUser.getStorageConfig();
    const dbSchema = await new PgSchemaIntrospection(client).tableSchema(TEST_TABLE);

    assert.ok(dbSchema !== null);

    const changes = diffSchema(config, dbSchema);

    // Should have no changes since we synced earlier
    // (only age column difference from previous test)
    assert.ok(Array.isArray(changes));
  });

  it('should detect foreign key constraints', async () => {
    // Create a model with a reference
    class Author extends defineModel({
      name: field.string(),
    }) {}

    class Post extends defineModel({
      title: field.string(),
      author: field.ref(Author),
    }) {}

    const PgAuthor = createPgModel(Author, {
      table: 'migration_test_authors',
    });

    const PgPost = createPgModel(Post, {
      table: 'migration_test_posts',
      relations: {
        author: { onDelete: 'CASCADE' },
      },
    });

    // Sync both models
    await new PgSchemaIntrospection(client).sync(PgAuthor, PgPost);

    // Check FK exists
    const fks = await new PgSchemaIntrospection(client).foreignKeys('migration_test_posts');
    const authorFk = fks.find(fk => fk.columnName === 'author_id');

    assert.ok(authorFk, 'Should have author_id FK');
    assert.strictEqual(authorFk.foreignTable, 'migration_test_authors');
    assert.strictEqual(authorFk.onDelete, 'CASCADE');

    // Clean up
    await client.sql.unsafe('DROP TABLE IF EXISTS migration_test_posts CASCADE');
    await client.sql.unsafe('DROP TABLE IF EXISTS migration_test_authors CASCADE');
  });

  it('should detect enum types', async () => {
    class Status extends defineModel({
      status: field.enum('order_status', ['pending', 'processing', 'shipped', 'delivered'] as const),
    }) {}

    const PgStatus = createPgModel(Status, {
      table: 'migration_test_status',
    });

    await new PgSchemaIntrospection(client).sync(PgStatus);

    // Check enum exists
    const enums = await new PgSchemaIntrospection(client).enumTypes();
    const orderStatus = enums.find(e => e.typeName === 'order_status');

    assert.ok(orderStatus, 'Should have order_status enum');
    assert.deepStrictEqual(orderStatus.values, ['pending', 'processing', 'shipped', 'delivered']);

    // Clean up
    await client.sql.unsafe('DROP TABLE IF EXISTS migration_test_status CASCADE');
    await client.sql.unsafe('DROP TYPE IF EXISTS order_status CASCADE');
  });
});

/**
 * Backfill functionality tests.
 *
 * Tests that .backfill() correctly:
 * 1. Adds NOT NULL columns with DEFAULT for existing rows
 * 2. Drops the DEFAULT after column is added (backfill-only, not permanent)
 */
describe('Backfill Functionality', async () => {
  if (!await requirePostgres()) return;

  let client: AbstractPostgresClient;
  let db: Database;
  const TABLE_NAME = 'backfill_test_users';

  before(async () => {
    client = createRawPostgresClient({
      connectionString: CONNECTION_STRING,
    });
    db = createMigrationDatabase(client);

    // Clean up any leftover test table
    await client.sql.unsafe(`DROP TABLE IF EXISTS ${TABLE_NAME} CASCADE`);
  });

  after(async () => {
    // Clean up
    await client.sql.unsafe(`DROP TABLE IF EXISTS ${TABLE_NAME} CASCADE`);
    await client.close();
  });

  it('should add NOT NULL column with backfill to existing rows', async () => {
    // Create initial table
    await db.createTable(TABLE_NAME, {
      id: field.uuid().primaryKey(),
      email: field.string().max(255),
    });

    // Insert some existing rows
    await client.sql.unsafe(`INSERT INTO ${TABLE_NAME} (id, email) VALUES (gen_random_uuid(), 'user1@test.com')`);
    await client.sql.unsafe(`INSERT INTO ${TABLE_NAME} (id, email) VALUES (gen_random_uuid(), 'user2@test.com')`);

    // Add NOT NULL column with backfill
    await db.alterTable(TABLE_NAME, (table) => {
      table.addColumn('name', field.string().max(100).backfill('Unknown'));
    });

    // Verify existing rows have the backfill value
    const rows = await client.sql.unsafe(`SELECT name FROM ${TABLE_NAME}`);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].name, 'Unknown');
    assert.strictEqual(rows[1].name, 'Unknown');
  });

  it('should drop default after backfill (no permanent default)', async () => {
    // Check that the column has no default now (backfill was dropped)
    const schema = await new PgSchemaIntrospection(client).tableSchema(TABLE_NAME);
    assert.ok(schema !== null);

    const nameColumn = schema.columns.find((c) => c.columnName === 'name');
    assert.ok(nameColumn, 'name column should exist');
    assert.strictEqual(nameColumn.columnDefault, null, 'backfill default should be dropped');
    assert.strictEqual(nameColumn.isNullable, false, 'column should be NOT NULL');
  });

  it('should require value for new inserts (no default after backfill)', async () => {
    // Trying to insert without name should fail (no default)
    await assert.rejects(
      async () => {
        await client.sql.unsafe(`INSERT INTO ${TABLE_NAME} (id, email) VALUES (gen_random_uuid(), 'user3@test.com')`);
      },
      /null value in column "name"/i,
      'Insert without name should fail after backfill default is dropped',
    );

    // Insert with name should work
    await client.sql.unsafe(`INSERT INTO ${TABLE_NAME} (id, email, name) VALUES (gen_random_uuid(), 'user3@test.com', 'User 3')`);

    const rows = await client.sql.unsafe(`SELECT * FROM ${TABLE_NAME} WHERE email = 'user3@test.com'`);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, 'User 3');
  });

  it('should keep permanent default when using .default() instead of .backfill()', async () => {
    // Add another column with .default() (permanent)
    await db.alterTable(TABLE_NAME, (table) => {
      table.addColumn('status', field.string().max(20).default('active'));
    });

    // Check that default is still present
    const schema = await new PgSchemaIntrospection(client).tableSchema(TABLE_NAME);
    const statusColumn = schema!.columns.find((c) => c.columnName === 'status');
    assert.ok(statusColumn, 'status column should exist');
    assert.ok(statusColumn.columnDefault !== null, 'permanent default should remain');
    assert.ok(statusColumn.columnDefault.includes('active'), 'default should be active');

    // Insert without status should work (has default)
    await client.sql.unsafe(`INSERT INTO ${TABLE_NAME} (id, email, name) VALUES (gen_random_uuid(), 'user4@test.com', 'User 4')`);

    const rows = await client.sql.unsafe(`SELECT status FROM ${TABLE_NAME} WHERE email = 'user4@test.com'`);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'active');
  });

  it('should handle integer backfill correctly', async () => {
    await db.alterTable(TABLE_NAME, (table) => {
      table.addColumn('age', field.int().backfill(0));
    });

    // Verify existing rows have the backfill value
    const rows = await client.sql.unsafe(`SELECT age FROM ${TABLE_NAME}`);
    for (const row of rows) {
      assert.strictEqual(row.age, 0);
    }

    // Verify default was dropped
    const schema = await new PgSchemaIntrospection(client).tableSchema(TABLE_NAME);
    const ageColumn = schema!.columns.find((c) => c.columnName === 'age');
    assert.ok(ageColumn, 'age column should exist');
    assert.strictEqual(ageColumn.columnDefault, null, 'integer backfill default should be dropped');
  });

  it('should handle boolean backfill correctly', async () => {
    await db.alterTable(TABLE_NAME, (table) => {
      table.addColumn('is_verified', field.boolean().backfill(false));
    });

    // Verify existing rows have the backfill value
    const rows = await client.sql.unsafe(`SELECT is_verified FROM ${TABLE_NAME}`);
    for (const row of rows) {
      assert.strictEqual(row.is_verified, false);
    }

    // Verify default was dropped
    const schema = await new PgSchemaIntrospection(client).tableSchema(TABLE_NAME);
    const verifiedColumn = schema!.columns.find((c) => c.columnName === 'is_verified');
    assert.ok(verifiedColumn, 'is_verified column should exist');
    assert.strictEqual(verifiedColumn.columnDefault, null, 'boolean backfill default should be dropped');
  });
});
