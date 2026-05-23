/**
 * SQL DDL AST Unit Tests
 *
 * Tests for the DDL Abstract Syntax Tree nodes (CREATE, ALTER, DROP).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  // Base class
  DdlNode,
  // Column Definition
  ColumnDef,
  // DDL Nodes
  CreateTable,
  DropTable,
  AlterTable,
  RenameTable,
  CreateIndex,
  DropIndex,
  CreateEnum,
  AlterEnumAddValue,
  DropType,
  AddForeignKey,
  DropConstraint,
  // Factory functions
  createTable,
  dropTable,
  createIndex,
  createEnum,
  addForeignKey,
} from '../src/sql/sql-ddl.js';

// ============================================================================
// Column Definition
// ============================================================================

describe('SQL DDL - ColumnDef', () => {
  it('should generate simple column definition', () => {
    const node = new ColumnDef('name', 'TEXT');
    assert.strictEqual(node.toSql(), 'name TEXT');
  });

  it('should generate column with NOT NULL', () => {
    const node = new ColumnDef('email', 'VARCHAR(255)', [{ type: 'notNull' }]);
    assert.strictEqual(node.toSql(), 'email VARCHAR(255) NOT NULL');
  });

  it('should generate column with PRIMARY KEY', () => {
    const node = new ColumnDef('id', 'UUID', [{ type: 'primaryKey' }]);
    assert.strictEqual(node.toSql(), 'id UUID PRIMARY KEY');
  });

  it('should generate column with UNIQUE', () => {
    const node = new ColumnDef('email', 'VARCHAR(255)', [{ type: 'unique' }]);
    assert.strictEqual(node.toSql(), 'email VARCHAR(255) UNIQUE');
  });

  it('should generate column with DEFAULT', () => {
    const node = new ColumnDef('status', 'TEXT', [
      { type: 'default', value: "'active'" },
    ]);
    assert.strictEqual(node.toSql(), "status TEXT DEFAULT 'active'");
  });

  it('should generate column with CHECK constraint', () => {
    const node = new ColumnDef('age', 'INTEGER', [
      { type: 'check', expression: 'age >= 0' },
    ]);
    assert.strictEqual(node.toSql(), 'age INTEGER CHECK (age >= 0)');
  });

  it('should generate column with REFERENCES', () => {
    const node = new ColumnDef('user_id', 'UUID', [
      { type: 'references', table: 'users', column: 'id' },
    ]);
    assert.strictEqual(node.toSql(), 'user_id UUID REFERENCES users(id)');
  });

  it('should generate column with REFERENCES and actions', () => {
    const node = new ColumnDef('user_id', 'UUID', [
      {
        type: 'references',
        table: 'users',
        column: 'id',
        onDelete: 'CASCADE',
        onUpdate: 'SET NULL',
      },
    ]);
    assert.strictEqual(
      node.toSql(),
      'user_id UUID REFERENCES users(id) ON DELETE CASCADE ON UPDATE SET NULL',
    );
  });

  it('should combine multiple constraints', () => {
    const node = new ColumnDef('email', 'VARCHAR(255)', [
      { type: 'notNull' },
      { type: 'unique' },
    ]);
    assert.strictEqual(node.toSql(), 'email VARCHAR(255) NOT NULL UNIQUE');
  });

  it('should be a DdlNode', () => {
    const node = new ColumnDef('x', 'TEXT');
    assert.ok(node instanceof DdlNode);
  });
});

// ============================================================================
// CREATE TABLE
// ============================================================================

describe('SQL DDL - CreateTable', () => {
  it('should generate simple CREATE TABLE', () => {
    const node = new CreateTable('users', [
      new ColumnDef('id', 'UUID', [{ type: 'primaryKey' }]),
      new ColumnDef('name', 'TEXT'),
    ]);
    assert.strictEqual(
      node.toSql(),
      'CREATE TABLE users (\n  id UUID PRIMARY KEY,\n  name TEXT\n)',
    );
  });

  it('should generate CREATE TABLE IF NOT EXISTS', () => {
    const node = new CreateTable(
      'users',
      [new ColumnDef('id', 'UUID', [{ type: 'primaryKey' }])],
      true,
    );
    assert.strictEqual(
      node.toSql(),
      'CREATE TABLE IF NOT EXISTS users (\n  id UUID PRIMARY KEY\n)',
    );
  });

  it('should handle multiple columns with constraints', () => {
    const node = new CreateTable('posts', [
      new ColumnDef('id', 'UUID', [
        { type: 'primaryKey' },
        { type: 'default', value: 'gen_random_uuid()' },
      ]),
      new ColumnDef('title', 'VARCHAR(200)', [{ type: 'notNull' }]),
      new ColumnDef('content', 'TEXT'),
      new ColumnDef('author_id', 'UUID', [
        { type: 'notNull' },
        { type: 'references', table: 'users', column: 'id', onDelete: 'CASCADE' },
      ]),
      new ColumnDef('created_at', 'TIMESTAMPTZ', [
        { type: 'notNull' },
        { type: 'default', value: 'NOW()' },
      ]),
    ]);

    const sql = node.toSql();
    assert.ok(sql.includes('CREATE TABLE posts'));
    assert.ok(sql.includes('id UUID PRIMARY KEY DEFAULT gen_random_uuid()'));
    assert.ok(sql.includes('title VARCHAR(200) NOT NULL'));
    assert.ok(sql.includes('content TEXT'));
    assert.ok(sql.includes('author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE'));
    assert.ok(sql.includes('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'));
  });
});

// ============================================================================
// DROP TABLE
// ============================================================================

describe('SQL DDL - DropTable', () => {
  it('should generate simple DROP TABLE', () => {
    const node = new DropTable('users');
    assert.strictEqual(node.toSql(), 'DROP TABLE users');
  });

  it('should generate DROP TABLE IF EXISTS', () => {
    const node = new DropTable('users', true);
    assert.strictEqual(node.toSql(), 'DROP TABLE IF EXISTS users');
  });

  it('should generate DROP TABLE CASCADE', () => {
    const node = new DropTable('users', false, true);
    assert.strictEqual(node.toSql(), 'DROP TABLE users CASCADE');
  });

  it('should generate DROP TABLE IF EXISTS CASCADE', () => {
    const node = new DropTable('users', true, true);
    assert.strictEqual(node.toSql(), 'DROP TABLE IF EXISTS users CASCADE');
  });
});

// ============================================================================
// ALTER TABLE
// ============================================================================

describe('SQL DDL - AlterTable', () => {
  it('should generate ADD COLUMN', () => {
    const node = new AlterTable('users', [
      { type: 'addColumn', column: new ColumnDef('email', 'VARCHAR(255)', [{ type: 'notNull' }]) },
    ]);
    assert.strictEqual(
      node.toSql(),
      'ALTER TABLE users ADD COLUMN email VARCHAR(255) NOT NULL',
    );
  });

  it('should generate DROP COLUMN', () => {
    const node = new AlterTable('users', [{ type: 'dropColumn', name: 'legacy_field' }]);
    assert.strictEqual(node.toSql(), 'ALTER TABLE users DROP COLUMN legacy_field');
  });

  it('should generate RENAME COLUMN', () => {
    const node = new AlterTable('users', [
      { type: 'renameColumn', from: 'old_name', to: 'new_name' },
    ]);
    assert.strictEqual(node.toSql(), 'ALTER TABLE users RENAME COLUMN old_name TO new_name');
  });

  it('should generate ALTER TYPE', () => {
    const node = new AlterTable('users', [
      { type: 'alterType', column: 'age', newType: 'BIGINT' },
    ]);
    assert.strictEqual(node.toSql(), 'ALTER TABLE users ALTER COLUMN age TYPE BIGINT');
  });

  it('should generate SET NOT NULL', () => {
    const node = new AlterTable('users', [{ type: 'setNotNull', column: 'email' }]);
    assert.strictEqual(node.toSql(), 'ALTER TABLE users ALTER COLUMN email SET NOT NULL');
  });

  it('should generate DROP NOT NULL', () => {
    const node = new AlterTable('users', [{ type: 'dropNotNull', column: 'nickname' }]);
    assert.strictEqual(node.toSql(), 'ALTER TABLE users ALTER COLUMN nickname DROP NOT NULL');
  });

  it('should generate SET DEFAULT', () => {
    const node = new AlterTable('users', [
      { type: 'setDefault', column: 'status', value: "'active'" },
    ]);
    assert.strictEqual(node.toSql(), "ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active'");
  });

  it('should generate DROP DEFAULT', () => {
    const node = new AlterTable('users', [{ type: 'dropDefault', column: 'status' }]);
    assert.strictEqual(node.toSql(), 'ALTER TABLE users ALTER COLUMN status DROP DEFAULT');
  });

  it('should generate ADD CONSTRAINT', () => {
    const node = new AlterTable('users', [
      { type: 'addConstraint', name: 'chk_age', definition: 'CHECK (age >= 0)' },
    ]);
    assert.strictEqual(
      node.toSql(),
      'ALTER TABLE users ADD CONSTRAINT chk_age CHECK (age >= 0)',
    );
  });

  it('should generate DROP CONSTRAINT', () => {
    const node = new AlterTable('users', [{ type: 'dropConstraint', name: 'old_constraint' }]);
    assert.strictEqual(node.toSql(), 'ALTER TABLE users DROP CONSTRAINT old_constraint');
  });

  it('should generate multiple alterations as separate statements', () => {
    const node = new AlterTable('users', [
      { type: 'addColumn', column: new ColumnDef('email', 'TEXT') },
      { type: 'dropColumn', name: 'old_email' },
    ]);
    assert.strictEqual(
      node.toSql(),
      'ALTER TABLE users ADD COLUMN email TEXT;\nALTER TABLE users DROP COLUMN old_email',
    );
  });
});

// ============================================================================
// RENAME TABLE
// ============================================================================

describe('SQL DDL - RenameTable', () => {
  it('should generate RENAME TABLE', () => {
    const node = new RenameTable('old_users', 'users');
    assert.strictEqual(node.toSql(), 'ALTER TABLE old_users RENAME TO users');
  });
});

// ============================================================================
// CREATE INDEX
// ============================================================================

describe('SQL DDL - CreateIndex', () => {
  it('should generate simple index with default name', () => {
    const node = new CreateIndex('users', ['email']);
    assert.strictEqual(
      node.toSql(),
      'CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)',
    );
  });

  it('should generate index on multiple columns', () => {
    const node = new CreateIndex('orders', ['user_id', 'created_at']);
    assert.strictEqual(
      node.toSql(),
      'CREATE INDEX IF NOT EXISTS idx_orders_user_id_created_at ON orders (user_id, created_at)',
    );
  });

  it('should generate UNIQUE index', () => {
    const node = new CreateIndex('users', ['email'], { unique: true });
    assert.strictEqual(
      node.toSql(),
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email)',
    );
  });

  it('should generate index with custom name', () => {
    const node = new CreateIndex('users', ['email'], { name: 'custom_email_idx' });
    assert.strictEqual(
      node.toSql(),
      'CREATE INDEX IF NOT EXISTS custom_email_idx ON users (email)',
    );
  });

  it('should generate index with USING clause', () => {
    const node = new CreateIndex('posts', ['tags'], { using: 'GIN' });
    assert.strictEqual(
      node.toSql(),
      'CREATE INDEX IF NOT EXISTS idx_posts_tags ON posts USING GIN (tags)',
    );
  });

  it('should generate partial index with WHERE', () => {
    const node = new CreateIndex('users', ['email'], { where: "status = 'active'" });
    assert.strictEqual(
      node.toSql(),
      "CREATE INDEX IF NOT EXISTS idx_users_email ON users (email) WHERE status = 'active'",
    );
  });

  it('should generate CONCURRENTLY index', () => {
    const node = new CreateIndex('users', ['email'], {
      concurrently: true,
      ifNotExists: false,
    });
    assert.strictEqual(
      node.toSql(),
      'CREATE INDEX CONCURRENTLY idx_users_email ON users (email)',
    );
  });

  it('should generate index without IF NOT EXISTS', () => {
    const node = new CreateIndex('users', ['email'], { ifNotExists: false });
    assert.strictEqual(node.toSql(), 'CREATE INDEX idx_users_email ON users (email)');
  });

  it('should combine multiple options', () => {
    const node = new CreateIndex('logs', ['created_at'], {
      name: 'idx_recent_logs',
      unique: false,
      using: 'BRIN',
      where: "created_at > NOW() - INTERVAL '30 days'",
      concurrently: true,
      ifNotExists: true,
    });
    assert.strictEqual(
      node.toSql(),
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_recent_logs ON logs USING BRIN (created_at) WHERE created_at > NOW() - INTERVAL '30 days'",
    );
  });
});

// ============================================================================
// DROP INDEX
// ============================================================================

describe('SQL DDL - DropIndex', () => {
  it('should generate simple DROP INDEX', () => {
    const node = new DropIndex('idx_users_email');
    assert.strictEqual(node.toSql(), 'DROP INDEX idx_users_email');
  });

  it('should generate DROP INDEX IF EXISTS', () => {
    const node = new DropIndex('idx_users_email', true);
    assert.strictEqual(node.toSql(), 'DROP INDEX IF EXISTS idx_users_email');
  });

  it('should generate DROP INDEX CONCURRENTLY', () => {
    const node = new DropIndex('idx_users_email', false, true);
    assert.strictEqual(node.toSql(), 'DROP INDEX CONCURRENTLY idx_users_email');
  });

  it('should generate DROP INDEX CONCURRENTLY IF EXISTS', () => {
    const node = new DropIndex('idx_users_email', true, true);
    assert.strictEqual(node.toSql(), 'DROP INDEX CONCURRENTLY IF EXISTS idx_users_email');
  });
});

// ============================================================================
// CREATE ENUM
// ============================================================================

describe('SQL DDL - CreateEnum', () => {
  it('should generate CREATE TYPE AS ENUM', () => {
    const node = new CreateEnum('user_status', ['active', 'inactive', 'banned']);
    assert.strictEqual(
      node.toSql(),
      "CREATE TYPE user_status AS ENUM ('active', 'inactive', 'banned')",
    );
  });

  it('should handle single value enum', () => {
    const node = new CreateEnum('singleton_type', ['only_value']);
    assert.strictEqual(node.toSql(), "CREATE TYPE singleton_type AS ENUM ('only_value')");
  });
});

// ============================================================================
// ALTER ENUM ADD VALUE
// ============================================================================

describe('SQL DDL - AlterEnumAddValue', () => {
  it('should generate ALTER TYPE ADD VALUE', () => {
    const node = new AlterEnumAddValue('user_status', 'suspended');
    assert.strictEqual(node.toSql(), "ALTER TYPE user_status ADD VALUE 'suspended'");
  });

  it('should generate ALTER TYPE ADD VALUE AFTER', () => {
    const node = new AlterEnumAddValue('user_status', 'suspended', { after: 'inactive' });
    assert.strictEqual(
      node.toSql(),
      "ALTER TYPE user_status ADD VALUE 'suspended' AFTER 'inactive'",
    );
  });

  it('should generate ALTER TYPE ADD VALUE BEFORE', () => {
    const node = new AlterEnumAddValue('priority', 'critical', { before: 'high' });
    assert.strictEqual(node.toSql(), "ALTER TYPE priority ADD VALUE 'critical' BEFORE 'high'");
  });
});

// ============================================================================
// DROP TYPE
// ============================================================================

describe('SQL DDL - DropType', () => {
  it('should generate DROP TYPE', () => {
    const node = new DropType('user_status');
    assert.strictEqual(node.toSql(), 'DROP TYPE user_status');
  });

  it('should generate DROP TYPE IF EXISTS', () => {
    const node = new DropType('user_status', true);
    assert.strictEqual(node.toSql(), 'DROP TYPE IF EXISTS user_status');
  });

  it('should generate DROP TYPE CASCADE', () => {
    const node = new DropType('user_status', false, true);
    assert.strictEqual(node.toSql(), 'DROP TYPE user_status CASCADE');
  });

  it('should generate DROP TYPE IF EXISTS CASCADE', () => {
    const node = new DropType('user_status', true, true);
    assert.strictEqual(node.toSql(), 'DROP TYPE IF EXISTS user_status CASCADE');
  });
});

// ============================================================================
// ADD FOREIGN KEY
// ============================================================================

describe('SQL DDL - AddForeignKey', () => {
  it('should generate ADD FOREIGN KEY with default name', () => {
    const node = new AddForeignKey('posts', {
      column: 'author_id',
      referencesTable: 'users',
    });
    assert.strictEqual(
      node.toSql(),
      'ALTER TABLE posts ADD CONSTRAINT fk_posts_author_id FOREIGN KEY (author_id) REFERENCES users(id)',
    );
  });

  it('should generate ADD FOREIGN KEY with custom name', () => {
    const node = new AddForeignKey('posts', {
      constraintName: 'posts_author_fkey',
      column: 'author_id',
      referencesTable: 'users',
    });
    assert.strictEqual(
      node.toSql(),
      'ALTER TABLE posts ADD CONSTRAINT posts_author_fkey FOREIGN KEY (author_id) REFERENCES users(id)',
    );
  });

  it('should generate ADD FOREIGN KEY with custom column', () => {
    const node = new AddForeignKey('orders', {
      column: 'customer_uuid',
      referencesTable: 'customers',
      referencesColumn: 'uuid',
    });
    assert.strictEqual(
      node.toSql(),
      'ALTER TABLE orders ADD CONSTRAINT fk_orders_customer_uuid FOREIGN KEY (customer_uuid) REFERENCES customers(uuid)',
    );
  });

  it('should generate ADD FOREIGN KEY with ON DELETE', () => {
    const node = new AddForeignKey('posts', {
      column: 'author_id',
      referencesTable: 'users',
      onDelete: 'CASCADE',
    });
    assert.strictEqual(
      node.toSql(),
      'ALTER TABLE posts ADD CONSTRAINT fk_posts_author_id FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE',
    );
  });

  it('should generate ADD FOREIGN KEY with ON UPDATE', () => {
    const node = new AddForeignKey('posts', {
      column: 'author_id',
      referencesTable: 'users',
      onUpdate: 'SET NULL',
    });
    assert.strictEqual(
      node.toSql(),
      'ALTER TABLE posts ADD CONSTRAINT fk_posts_author_id FOREIGN KEY (author_id) REFERENCES users(id) ON UPDATE SET NULL',
    );
  });

  it('should generate ADD FOREIGN KEY with both actions', () => {
    const node = new AddForeignKey('comments', {
      column: 'post_id',
      referencesTable: 'posts',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });
    assert.strictEqual(
      node.toSql(),
      'ALTER TABLE comments ADD CONSTRAINT fk_comments_post_id FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE ON UPDATE CASCADE',
    );
  });
});

// ============================================================================
// DROP CONSTRAINT
// ============================================================================

describe('SQL DDL - DropConstraint', () => {
  it('should generate DROP CONSTRAINT', () => {
    const node = new DropConstraint('posts', 'fk_posts_author_id');
    assert.strictEqual(node.toSql(), 'ALTER TABLE posts DROP CONSTRAINT fk_posts_author_id');
  });

  it('should generate DROP CONSTRAINT IF EXISTS', () => {
    const node = new DropConstraint('posts', 'fk_posts_author_id', true);
    assert.strictEqual(
      node.toSql(),
      'ALTER TABLE posts DROP CONSTRAINT IF EXISTS fk_posts_author_id',
    );
  });
});

// ============================================================================
// Factory Functions
// ============================================================================

describe('SQL DDL - Factory Functions', () => {
  it('dropTable() creates DropTable', () => {
    assert.strictEqual(dropTable('users').toSql(), 'DROP TABLE users');
    assert.strictEqual(dropTable('users', true).toSql(), 'DROP TABLE IF EXISTS users');
    assert.strictEqual(dropTable('users', true, true).toSql(), 'DROP TABLE IF EXISTS users CASCADE');
  });

  it('createIndex() creates CreateIndex with single column', () => {
    const node = createIndex('users', 'email');
    assert.ok(node.toSql().includes('idx_users_email'));
    assert.ok(node.toSql().includes('(email)'));
  });

  it('createIndex() creates CreateIndex with multiple columns', () => {
    const node = createIndex('orders', ['user_id', 'status'], { unique: true });
    assert.ok(node.toSql().includes('CREATE UNIQUE INDEX'));
    assert.ok(node.toSql().includes('(user_id, status)'));
  });

  it('createEnum() creates CreateEnum', () => {
    const node = createEnum('status', ['a', 'b', 'c']);
    assert.strictEqual(node.toSql(), "CREATE TYPE status AS ENUM ('a', 'b', 'c')");
  });

  it('addForeignKey() creates AddForeignKey', () => {
    const node = addForeignKey('posts', {
      column: 'user_id',
      referencesTable: 'users',
      onDelete: 'CASCADE',
    });
    assert.ok(node.toSql().includes('FOREIGN KEY (user_id)'));
    assert.ok(node.toSql().includes('REFERENCES users(id)'));
    assert.ok(node.toSql().includes('ON DELETE CASCADE'));
  });
});

// ============================================================================
// ColumnDef.fromField
// ============================================================================

describe('SQL DDL - ColumnDef.fromField', () => {
  it('should create column from string field', () => {
    const col = ColumnDef.fromField('name', { type: 'string', maxLength: 100 });
    assert.strictEqual(col.toSql(), 'name VARCHAR(100) NOT NULL');
  });

  it('should create column from optional string field', () => {
    const col = ColumnDef.fromField('nickname', { type: 'string', optional: true });
    assert.strictEqual(col.toSql(), 'nickname TEXT');
  });

  it('should create column from uuid primary key', () => {
    const col = ColumnDef.fromField('id', { type: 'uuid', primaryKey: true });
    assert.strictEqual(col.toSql(), 'id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
  });

  it('should create column from integer', () => {
    const col = ColumnDef.fromField('age', { type: 'int' });
    assert.strictEqual(col.toSql(), 'age INTEGER NOT NULL');
  });

  it('should create column from decimal with precision', () => {
    const col = ColumnDef.fromField('price', { type: 'decimal', precision: 10, scale: 2 });
    assert.strictEqual(col.toSql(), 'price DECIMAL(10,2) NOT NULL');
  });

  it('should create column from boolean', () => {
    const col = ColumnDef.fromField('active', { type: 'boolean' });
    assert.strictEqual(col.toSql(), 'active BOOLEAN NOT NULL');
  });

  it('should create column from timestamp', () => {
    const col = ColumnDef.fromField('event_time', { type: 'timestamp' });
    assert.strictEqual(col.toSql(), 'event_time TIMESTAMPTZ NOT NULL');
  });

  it('should create column from createdAt', () => {
    const col = ColumnDef.fromField('created_at', { type: 'createdAt' });
    assert.strictEqual(col.toSql(), 'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  });

  it('should create column from updatedAt', () => {
    const col = ColumnDef.fromField('updated_at', { type: 'updatedAt' });
    assert.strictEqual(col.toSql(), 'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  });

  it('should create column from enum', () => {
    const col = ColumnDef.fromField('status', { type: 'enum', enumName: 'user_status' });
    assert.strictEqual(col.toSql(), 'status user_status NOT NULL');
  });

  it('should create column from jsonb', () => {
    const col = ColumnDef.fromField('data', { type: 'jsonb' });
    assert.strictEqual(col.toSql(), 'data JSONB NOT NULL');
  });

  it('should create column with default value', () => {
    const col = ColumnDef.fromField('status', { type: 'string', defaultValue: 'active' });
    assert.strictEqual(col.toSql(), "status TEXT NOT NULL DEFAULT 'active'");
  });

  it('should create column with backfill value', () => {
    const col = ColumnDef.fromField('role', { type: 'string', backfillValue: 'user' });
    assert.strictEqual(col.toSql(), "role TEXT NOT NULL DEFAULT 'user'");
  });

  it('should create column with unique constraint', () => {
    const col = ColumnDef.fromField('email', { type: 'string', maxLength: 255, unique: true });
    assert.strictEqual(col.toSql(), 'email VARCHAR(255) NOT NULL UNIQUE');
  });

  it('should create column from version field', () => {
    const col = ColumnDef.fromField('version', { type: 'version' });
    assert.strictEqual(col.toSql(), 'version INTEGER NOT NULL DEFAULT 1');
  });

  it('should create column from array field', () => {
    const col = ColumnDef.fromField('tags', { type: 'array', arrayOf: { type: 'string' } });
    assert.strictEqual(col.toSql(), 'tags TEXT[] NOT NULL');
  });

  it('should create column from ref field', () => {
    const col = ColumnDef.fromField('author_id', { type: 'ref' });
    assert.strictEqual(col.toSql(), 'author_id UUID NOT NULL');
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('SQL DDL - Edge Cases', () => {
  describe('Column Definition Edge Cases', () => {
    it('should handle empty column name', () => {
      const node = new ColumnDef('', 'TEXT');
      assert.strictEqual(node.toSql(), ' TEXT');
    });

    it('should handle column with all constraints', () => {
      const node = new ColumnDef('email', 'VARCHAR(255)', [
        { type: 'notNull' },
        { type: 'unique' },
        { type: 'default', value: "''" },
        { type: 'check', expression: "email LIKE '%@%'" },
      ]);
      const sql = node.toSql();
      assert.ok(sql.includes('NOT NULL'));
      assert.ok(sql.includes('UNIQUE'));
      assert.ok(sql.includes("DEFAULT ''"));
      assert.ok(sql.includes('CHECK'));
    });

    it('should handle column with very long type definition', () => {
      const node = new ColumnDef('value', 'NUMERIC(38,18)');
      assert.strictEqual(node.toSql(), 'value NUMERIC(38,18)');
    });

    it('should handle column with references and both actions', () => {
      const node = new ColumnDef('parent_id', 'UUID', [
        { type: 'references', table: 'items', column: 'id', onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      ]);
      const sql = node.toSql();
      assert.ok(sql.includes('ON DELETE SET NULL'));
      assert.ok(sql.includes('ON UPDATE CASCADE'));
    });

    it('should handle column with underscore-heavy name', () => {
      const node = new ColumnDef('user_profile_settings_backup_id', 'UUID');
      assert.strictEqual(node.toSql(), 'user_profile_settings_backup_id UUID');
    });

    it('should handle numeric column types', () => {
      assert.strictEqual(new ColumnDef('a', 'SMALLINT').toSql(), 'a SMALLINT');
      assert.strictEqual(new ColumnDef('b', 'BIGINT').toSql(), 'b BIGINT');
      assert.strictEqual(new ColumnDef('c', 'REAL').toSql(), 'c REAL');
      assert.strictEqual(new ColumnDef('d', 'DOUBLE PRECISION').toSql(), 'd DOUBLE PRECISION');
    });

    it('should handle array types', () => {
      assert.strictEqual(new ColumnDef('tags', 'TEXT[]').toSql(), 'tags TEXT[]');
      assert.strictEqual(new ColumnDef('ids', 'UUID[]').toSql(), 'ids UUID[]');
      assert.strictEqual(new ColumnDef('matrix', 'INTEGER[][]').toSql(), 'matrix INTEGER[][]');
    });
  });

  describe('CreateTable Edge Cases', () => {
    it('should handle table with single column', () => {
      const node = new CreateTable('simple', [new ColumnDef('id', 'SERIAL')]);
      assert.strictEqual(node.toSql(), 'CREATE TABLE simple (\n  id SERIAL\n)');
    });

    it('should handle table with many columns', () => {
      const columns = Array.from({ length: 20 }, (_, i) =>
        new ColumnDef(`col${i}`, 'TEXT')
      );
      const node = new CreateTable('wide_table', columns);
      const sql = node.toSql();
      assert.ok(sql.includes('col0 TEXT'));
      assert.ok(sql.includes('col19 TEXT'));
    });

    it('should handle table with reserved word name', () => {
      // Note: In practice you'd quote this, but DDL generator passes through as-is
      const node = new CreateTable('order', [new ColumnDef('id', 'UUID')]);
      assert.strictEqual(node.toSql(), 'CREATE TABLE order (\n  id UUID\n)');
    });

    it('should handle schema-qualified table name', () => {
      const node = new CreateTable('myschema.users', [new ColumnDef('id', 'UUID')]);
      assert.ok(node.toSql().includes('myschema.users'));
    });
  });

  describe('AlterTable Edge Cases', () => {
    it('should handle multiple operations in sequence', () => {
      const node = new AlterTable('users', [
        { type: 'addColumn', column: new ColumnDef('email', 'TEXT') },
        { type: 'addColumn', column: new ColumnDef('phone', 'TEXT') },
        { type: 'dropColumn', name: 'old_field' },
      ]);
      const sql = node.toSql();
      assert.ok(sql.includes('ADD COLUMN email'));
      assert.ok(sql.includes('ADD COLUMN phone'));
      assert.ok(sql.includes('DROP COLUMN old_field'));
    });

    it('should handle empty alterations array', () => {
      const node = new AlterTable('users', []);
      const sql = node.toSql();
      // Empty alterations produces just "ALTER TABLE tableName" with no operations
      assert.strictEqual(sql, '');
    });

    it('should handle SET NOT NULL on existing column', () => {
      const node = new AlterTable('users', [
        { type: 'setNotNull', column: 'email' },
      ]);
      assert.ok(node.toSql().includes('SET NOT NULL'));
    });

    it('should handle DROP NOT NULL on existing column', () => {
      const node = new AlterTable('users', [
        { type: 'dropNotNull', column: 'nickname' },
      ]);
      assert.ok(node.toSql().includes('DROP NOT NULL'));
    });

    it('should handle SET DEFAULT on column', () => {
      const node = new AlterTable('orders', [
        { type: 'setDefault', column: 'status', value: "'pending'" },
      ]);
      assert.ok(node.toSql().includes("DEFAULT 'pending'"));
    });

    it('should handle DROP DEFAULT on column', () => {
      const node = new AlterTable('orders', [
        { type: 'dropDefault', column: 'status' },
      ]);
      assert.ok(node.toSql().includes('DROP DEFAULT'));
    });

    it('should handle TYPE change', () => {
      const node = new AlterTable('users', [
        { type: 'alterType', column: 'age', newType: 'BIGINT' },
      ]);
      assert.ok(node.toSql().includes('TYPE BIGINT'));
    });

    it('should handle rename column', () => {
      const node = new AlterTable('users', [
        { type: 'renameColumn', from: 'old_name', to: 'new_name' },
      ]);
      assert.ok(node.toSql().includes('RENAME COLUMN old_name TO new_name'));
    });

    it('should handle add constraint', () => {
      const node = new AlterTable('users', [
        { type: 'addConstraint', name: 'uq_email', definition: 'UNIQUE (email)' },
      ]);
      assert.ok(node.toSql().includes('ADD CONSTRAINT uq_email UNIQUE (email)'));
    });
  });

  describe('CreateIndex Edge Cases', () => {
    it('should handle index on single column', () => {
      const node = new CreateIndex('users', ['email']);
      assert.ok(node.toSql().includes('(email)'));
    });

    it('should handle index on many columns', () => {
      const node = new CreateIndex('orders', ['user_id', 'status', 'created_at', 'total']);
      assert.ok(node.toSql().includes('(user_id, status, created_at, total)'));
    });

    it('should handle unique index', () => {
      const node = new CreateIndex('users', ['email'], { unique: true });
      assert.ok(node.toSql().includes('CREATE UNIQUE INDEX'));
    });

    it('should handle index with IF NOT EXISTS', () => {
      const node = new CreateIndex('users', ['email'], { ifNotExists: true });
      assert.ok(node.toSql().includes('IF NOT EXISTS'));
    });

    it('should handle unique index with IF NOT EXISTS', () => {
      const node = new CreateIndex('users', ['email'], { unique: true, ifNotExists: true });
      const sql = node.toSql();
      assert.ok(sql.includes('CREATE UNIQUE INDEX'));
      assert.ok(sql.includes('IF NOT EXISTS'));
    });

    it('should handle index on expression-like column', () => {
      const node = new CreateIndex('users', ['LOWER(email)']);
      assert.ok(node.toSql().includes('LOWER(email)'));
    });

    it('should handle index with custom name', () => {
      const node = new CreateIndex('users', ['email'], { name: 'custom_idx_name' });
      assert.ok(node.toSql().includes('custom_idx_name'));
    });

    it('should handle index with USING clause', () => {
      const node = new CreateIndex('users', ['data'], { using: 'gin' });
      assert.ok(node.toSql().includes('USING gin'));
    });

    it('should handle partial index with WHERE', () => {
      const node = new CreateIndex('users', ['email'], { where: 'active = true' });
      assert.ok(node.toSql().includes('WHERE active = true'));
    });

    it('should handle CONCURRENTLY', () => {
      const node = new CreateIndex('users', ['email'], { concurrently: true });
      assert.ok(node.toSql().includes('CONCURRENTLY'));
    });
  });

  describe('DropIndex Edge Cases', () => {
    it('should handle simple drop', () => {
      const node = new DropIndex('idx_users_email');
      assert.strictEqual(node.toSql(), 'DROP INDEX idx_users_email');
    });

    it('should handle IF EXISTS', () => {
      const node = new DropIndex('idx_users_email', true);
      assert.strictEqual(node.toSql(), 'DROP INDEX IF EXISTS idx_users_email');
    });

    it('should handle CONCURRENTLY', () => {
      const node = new DropIndex('idx_users_email', false, true);
      assert.strictEqual(node.toSql(), 'DROP INDEX CONCURRENTLY idx_users_email');
    });

    it('should handle CONCURRENTLY IF EXISTS', () => {
      const node = new DropIndex('idx_users_email', true, true);
      assert.strictEqual(node.toSql(), 'DROP INDEX CONCURRENTLY IF EXISTS idx_users_email');
    });
  });

  describe('CreateEnum Edge Cases', () => {
    it('should handle enum with single value', () => {
      const node = new CreateEnum('single_status', ['only']);
      assert.strictEqual(node.toSql(), "CREATE TYPE single_status AS ENUM ('only')");
    });

    it('should handle enum with many values', () => {
      const values = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
      const node = new CreateEnum('many_values', values);
      const sql = node.toSql();
      values.forEach(v => assert.ok(sql.includes(`'${v}'`)));
    });

    it('should handle enum values with special characters', () => {
      // Note: In practice you'd escape these, but testing raw behavior
      const node = new CreateEnum('special', ['value-with-dash', 'value_with_underscore']);
      assert.ok(node.toSql().includes("'value-with-dash'"));
      assert.ok(node.toSql().includes("'value_with_underscore'"));
    });

    it('should handle empty enum', () => {
      const node = new CreateEnum('empty_enum', []);
      assert.strictEqual(node.toSql(), 'CREATE TYPE empty_enum AS ENUM ()');
    });
  });

  describe('AlterEnumAddValue Edge Cases', () => {
    it('should handle adding at end (no position)', () => {
      const node = new AlterEnumAddValue('status', 'new_value');
      assert.strictEqual(node.toSql(), "ALTER TYPE status ADD VALUE 'new_value'");
    });

    it('should handle BEFORE position', () => {
      const node = new AlterEnumAddValue('status', 'new', { before: 'existing' });
      assert.strictEqual(node.toSql(), "ALTER TYPE status ADD VALUE 'new' BEFORE 'existing'");
    });

    it('should handle AFTER position', () => {
      const node = new AlterEnumAddValue('status', 'new', { after: 'existing' });
      assert.strictEqual(node.toSql(), "ALTER TYPE status ADD VALUE 'new' AFTER 'existing'");
    });

    it('should handle special characters in value', () => {
      const node = new AlterEnumAddValue('status', 'new-value_with_chars');
      assert.strictEqual(node.toSql(), "ALTER TYPE status ADD VALUE 'new-value_with_chars'");
    });
  });

  describe('DropType Edge Cases', () => {
    it('should handle simple drop', () => {
      const node = new DropType('old_enum');
      assert.strictEqual(node.toSql(), 'DROP TYPE old_enum');
    });

    it('should handle IF EXISTS', () => {
      const node = new DropType('maybe_exists', true);
      assert.strictEqual(node.toSql(), 'DROP TYPE IF EXISTS maybe_exists');
    });

    it('should handle CASCADE', () => {
      const node = new DropType('used_enum', false, true);
      assert.strictEqual(node.toSql(), 'DROP TYPE used_enum CASCADE');
    });

    it('should handle IF EXISTS CASCADE', () => {
      const node = new DropType('maybe_used', true, true);
      assert.strictEqual(node.toSql(), 'DROP TYPE IF EXISTS maybe_used CASCADE');
    });
  });

  describe('RenameTable Edge Cases', () => {
    it('should rename table', () => {
      const node = new RenameTable('old_name', 'new_name');
      assert.strictEqual(node.toSql(), 'ALTER TABLE old_name RENAME TO new_name');
    });

    it('should handle schema-qualified names', () => {
      const node = new RenameTable('schema.old', 'schema.new');
      assert.ok(node.toSql().includes('schema.old'));
      assert.ok(node.toSql().includes('schema.new'));
    });
  });

  describe('AddForeignKey Edge Cases', () => {
    it('should handle minimal foreign key', () => {
      const node = new AddForeignKey('posts', { column: 'user_id', referencesTable: 'users' });
      const sql = node.toSql();
      assert.ok(sql.includes('FOREIGN KEY (user_id)'));
      assert.ok(sql.includes('REFERENCES users(id)'));
    });

    it('should handle foreign key with custom reference column', () => {
      const node = new AddForeignKey('posts', { column: 'author_email', referencesTable: 'users', referencesColumn: 'email' });
      assert.ok(node.toSql().includes('REFERENCES users(email)'));
    });

    it('should handle all ON actions', () => {
      const node = new AddForeignKey('posts', { column: 'user_id', referencesTable: 'users', onDelete: 'SET NULL', onUpdate: 'CASCADE' });
      const sql = node.toSql();
      assert.ok(sql.includes('ON DELETE SET NULL'));
      assert.ok(sql.includes('ON UPDATE CASCADE'));
    });

    it('should handle constraint name', () => {
      const node = new AddForeignKey('posts', { column: 'user_id', referencesTable: 'users', constraintName: 'fk_custom_name' });
      assert.ok(node.toSql().includes('fk_custom_name'));
    });
  });

  describe('DropConstraint Edge Cases', () => {
    it('should drop constraint', () => {
      const node = new DropConstraint('users', 'uq_users_email');
      assert.strictEqual(node.toSql(), 'ALTER TABLE users DROP CONSTRAINT uq_users_email');
    });

    it('should handle IF EXISTS', () => {
      const node = new DropConstraint('users', 'maybe_exists', true);
      assert.ok(node.toSql().includes('IF EXISTS'));
    });

    it('should handle long constraint names', () => {
      const longName = 'fk_this_is_a_very_long_constraint_name_that_might_cause_issues';
      const node = new DropConstraint('table', longName);
      assert.ok(node.toSql().includes(longName));
    });
  });

  describe('ColumnDef.fromField Edge Cases', () => {
    it('should handle text without maxLength', () => {
      const col = ColumnDef.fromField('bio', { type: 'string' });
      assert.strictEqual(col.toSql(), 'bio TEXT NOT NULL');
    });

    it('should handle decimal with scale only', () => {
      const col = ColumnDef.fromField('value', { type: 'decimal', scale: 4 });
      assert.ok(col.toSql().includes('DECIMAL'));
    });

    it('should handle optional enum', () => {
      const col = ColumnDef.fromField('status', { type: 'enum', enumName: 'status_type', optional: true });
      assert.strictEqual(col.toSql(), 'status status_type');
    });

    it('should handle optional boolean with default', () => {
      const col = ColumnDef.fromField('enabled', { type: 'boolean', optional: true, defaultValue: true });
      assert.ok(col.toSql().includes('BOOLEAN'));
      assert.ok(col.toSql().includes('DEFAULT'));
    });

    it('should handle date type', () => {
      const col = ColumnDef.fromField('birth_date', { type: 'date' });
      assert.ok(col.toSql().includes('DATE') || col.toSql().includes('TIMESTAMPTZ'));
    });

    it('should handle text type explicitly', () => {
      const col = ColumnDef.fromField('content', { type: 'text' });
      assert.strictEqual(col.toSql(), 'content TEXT NOT NULL');
    });

    it('should handle bigint type', () => {
      const col = ColumnDef.fromField('large_id', { type: 'bigint' });
      assert.ok(col.toSql().includes('BIGINT'));
    });
  });
});
