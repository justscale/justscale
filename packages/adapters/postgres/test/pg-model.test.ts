/**
 * Tests for createPgModel
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import { defineModel, field } from '@justscale/core/models';
import { createPgModel } from '../src/index.js';
import { pg } from '../src/testing/index.js';

// =============================================================================
// Test Models (domain models)
// =============================================================================

class User extends defineModel({
  email: field.string(),
  firstName: field.string(),
  lastName: field.string(),
  isActive: field.boolean(),
}) {}

class Category extends defineModel({
  name: field.string(),
}) {}

class BlogPost extends defineModel({
  title: field.string(),
  content: field.text(),
}) {}

class UserProfile extends defineModel({
  bio: field.text(),
}) {}

class Post extends defineModel({
  title: field.string(),
}) {}

class Model extends defineModel({
  stringField: field.string(),
  textField: field.text(),
  intField: field.int(),
  boolField: field.boolean(),
  decimalField: field.decimal(10, 2),
  enumField: field.enum('Status', ['a', 'b'] as const),
  timestampField: field.createdAt(),
}) {}

// =============================================================================
// Basic Model Creation
// =============================================================================

describe('createPgModel', () => {
  test('creates storage model with default table name (pluralized snake_case)', () => {
    const PgUser = createPgModel(User, {});

    assert.strictEqual(PgUser.name, 'User');
    assert.strictEqual(PgUser.table, 'users');
    assert.strictEqual(PgUser.storageMode, 'columnar');
  });

  test('pluralizes model names correctly', () => {
    // Simple plural
    const PgPost = createPgModel(Post, {});
    assert.strictEqual(PgPost.table, 'posts');

    // Ends in 'y' -> 'ies'
    const PgCategory = createPgModel(Category, {});
    assert.strictEqual(PgCategory.table, 'categories');

    // PascalCase -> snake_case
    const PgBlogPost = createPgModel(BlogPost, {});
    assert.strictEqual(PgBlogPost.table, 'blog_posts');

    const PgUserProfile = createPgModel(UserProfile, {});
    assert.strictEqual(PgUserProfile.table, 'user_profiles');
  });

  test('uses custom table name when provided', () => {
    const PgUser = createPgModel(User, {
      table: 'app_users',
    });

    assert.strictEqual(PgUser.table, 'app_users');
  });

  test('uses jsonb storage mode when specified', () => {
    const PgUser = createPgModel(User, {
      storageMode: 'jsonb',
      dataColumn: 'payload',
    });

    assert.strictEqual(PgUser.storageMode, 'jsonb');
  });

  test('exposes the underlying model', () => {
    const PgUser = createPgModel(User, {});

    assert.strictEqual(PgUser.model, User);
    assert.strictEqual(PgUser.model.name, 'User');
  });
});

// =============================================================================
// Column Inference
// =============================================================================

describe('createPgModel - Column Inference', () => {
  test('converts camelCase fields to snake_case columns', () => {
    const PgUser = createPgModel(User, {});

    assert.strictEqual(PgUser.columns.email, 'email');
    assert.strictEqual(PgUser.columns.firstName, 'first_name');
    assert.strictEqual(PgUser.columns.lastName, 'last_name');
    assert.strictEqual(PgUser.columns.isActive, 'is_active');
  });

  test('uses custom column mapping when provided', () => {
    const PgUser = createPgModel(User, {
      columnMap: {
        firstName: 'name', // Custom mapping
      },
    });

    assert.strictEqual(PgUser.columns.email, 'email');
    assert.strictEqual(PgUser.columns.firstName, 'name');
  });

  test('preserves field names when preserveFieldNames is true', () => {
    const PgUser = createPgModel(User, {
      preserveFieldNames: true,
    });

    assert.strictEqual(PgUser.columns.email, 'email');
    assert.strictEqual(PgUser.columns.firstName, 'firstName'); // Not converted
  });
});

// =============================================================================
// Column Metadata
// =============================================================================

describe('createPgModel - Column Metadata', () => {
  test('getColumnMeta returns field metadata', () => {
    class UserWithConstraints extends defineModel({
      email: field.string().max(255).unique(),
      displayName: field.string().optional(),
      age: field.int(),
    }) {}

    const PgUser = createPgModel(UserWithConstraints, {});

    const meta = PgUser.getColumnMeta();

    assert.strictEqual(meta.length, 3);

    const emailMeta = meta.find((m) => m.fieldName === 'email');
    assert.ok(emailMeta);
    assert.strictEqual(emailMeta.columnName, 'email');
    assert.strictEqual(emailMeta.fieldType, 'string');
    assert.strictEqual(emailMeta.pgType, 'VARCHAR(255)');
    assert.strictEqual(emailMeta.nullable, false);
    assert.strictEqual(emailMeta.unique, true);

    const displayNameMeta = meta.find((m) => m.fieldName === 'displayName');
    assert.ok(displayNameMeta);
    assert.strictEqual(displayNameMeta.columnName, 'display_name');
    assert.strictEqual(displayNameMeta.nullable, true);
    assert.strictEqual(displayNameMeta.unique, false);
  });

  test('getColumnMeta includes PostgreSQL types', () => {
    const PgModel = createPgModel(Model, {});

    const meta = PgModel.getColumnMeta();

    assert.strictEqual(meta.find((m) => m.fieldName === 'stringField')?.pgType, 'TEXT');
    assert.strictEqual(meta.find((m) => m.fieldName === 'textField')?.pgType, 'TEXT');
    assert.strictEqual(meta.find((m) => m.fieldName === 'intField')?.pgType, 'INTEGER');
    assert.strictEqual(meta.find((m) => m.fieldName === 'boolField')?.pgType, 'BOOLEAN');
    assert.strictEqual(meta.find((m) => m.fieldName === 'decimalField')?.pgType, 'DECIMAL(10,2)');
    assert.strictEqual(meta.find((m) => m.fieldName === 'timestampField')?.pgType, 'TIMESTAMPTZ');
  });

  test('overrides modify column metadata', () => {
    const PgUser = createPgModel(User, {
      overrides: {
        email: { type: 'CITEXT', unique: true, index: true },
      },
    });

    const meta = PgUser.getColumnMeta();
    const emailMeta = meta.find((m) => m.fieldName === 'email');

    assert.ok(emailMeta);
    assert.strictEqual(emailMeta.pgType, 'CITEXT');
    assert.strictEqual(emailMeta.unique, true);
    assert.ok(emailMeta.override?.index);
  });
});

// =============================================================================
// Storage Configuration
// =============================================================================

describe('createPgModel - Storage Config', () => {
  test('getStorageConfig returns full configuration', () => {
    const PgUser = createPgModel(User, {
      table: 'app_users',
      indexes: [
        { fields: ['email'], unique: true },
        { fields: ['firstName', 'lastName'] },
      ],
      overrides: {
        email: { index: true },
      },
    });

    const config = PgUser.getStorageConfig();

    assert.strictEqual(config.table, 'app_users');
    assert.strictEqual(config.storageMode, 'columnar');
    assert.strictEqual(config.indexes.length, 2);
    assert.ok(config.indexes[0].unique);
    assert.deepStrictEqual(config.indexes[0].fields, ['email']);
  });

  test('relations config is captured', () => {
    class PostWithAuthor extends defineModel({
      title: field.string(),
      author: field.ref(User),
    }) {}

    const PgPost = createPgModel(PostWithAuthor, {
      relations: {
        author: { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      },
    });

    const config = PgPost.getStorageConfig();
    const authorRelation = config.relations.get('author');

    assert.ok(authorRelation);
    assert.strictEqual(authorRelation.onDelete, 'CASCADE');
    assert.strictEqual(authorRelation.onUpdate, 'CASCADE');
  });

  test('jsonb fields are tracked', () => {
    class UserWithSettings extends defineModel({
      email: field.string(),
      settings: field.object({ theme: field.string() }),
    }) {}

    const PgUser = createPgModel(UserWithSettings, {
      jsonb: ['settings'],
    });

    const config = PgUser.getStorageConfig();

    assert.ok(config.jsonbFields.has('settings'));
  });
});

// =============================================================================
// DDL Generation
// =============================================================================

describe('createPgModel - DDL Generation', () => {
  test('pg.generateCreateTableSQL creates valid SQL', () => {
    const PgUser = createPgModel(User, {
      table: 'users',
    });

    const sql = pg.generateCreateTableSQL(PgUser.getStorageConfig());

    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS users'));
    assert.ok(sql.includes('id UUID PRIMARY KEY'));
    assert.ok(sql.includes('created_at TIMESTAMPTZ'));
    assert.ok(sql.includes('updated_at TIMESTAMPTZ'));
    assert.ok(sql.includes('version INTEGER'));
    assert.ok(sql.includes('email TEXT'));
    assert.ok(sql.includes('first_name TEXT'));
  });

  test('pg.generateCreateTableSQL handles jsonb mode', () => {
    const PgUser = createPgModel(User, {
      table: 'users',
      storageMode: 'jsonb',
      dataColumn: 'payload',
    });

    const sql = pg.generateCreateTableSQL(PgUser.getStorageConfig());

    assert.ok(sql.includes('payload JSONB'));
    // Should not include individual columns
    assert.ok(!sql.includes('first_name'));
  });

  test('pg.generateIndexSQL creates index statements', () => {
    const PgUser = createPgModel(User, {
      table: 'users',
      indexes: [
        { fields: ['email'], unique: true },
        { fields: ['firstName', 'lastName'], name: 'idx_users_full_name' },
      ],
      overrides: {
        isActive: { index: true },
      },
    });

    const statements = pg.generateIndexSQL(PgUser.getStorageConfig());

    // Auto-generated indexes
    assert.ok(statements.some((s) => s.includes('idx_users_created_at')));
    assert.ok(statements.some((s) => s.includes('idx_users_updated_at')));

    // User-defined indexes
    assert.ok(statements.some((s) => s.includes('UNIQUE INDEX') && s.includes('email')));
    assert.ok(statements.some((s) => s.includes('idx_users_full_name')));

    // Override indexes
    assert.ok(statements.some((s) => s.includes('idx_users_is_active')));
  });
});

// =============================================================================
// Repository Factory
// =============================================================================

describe('createPgModel - Repository Factory', () => {
  test('repository function exists', () => {
    const PgUser = createPgModel(User, {});

    assert.strictEqual(typeof PgUser.repository, 'function');
  });

  // Note: Actual repository functionality is tested in pg-repository.e2e.test.ts
  // This just verifies the factory pattern works
});
