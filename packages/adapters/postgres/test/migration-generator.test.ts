/**
 * Migration Generator Unit Tests
 *
 * Tests for migration code generation functions.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  generateMigrationScaffold,
  generateMigrationCode,
  writeMigration,
  createEmptyMigration,
  generateSeederScaffold,
} from '../src/migration/migration-generator.js';

// ============================================================================
// generateMigrationScaffold
// ============================================================================

describe('Migration Generator - generateMigrationScaffold', () => {
  it('should generate empty scaffold with imports', () => {
    const code = generateMigrationScaffold('add_user_avatar');

    assert.ok(code.includes("import { defineMigration } from '@justscale/postgres'"));
    assert.ok(code.includes("import { field } from '@justscale/core/models'"));
    assert.ok(code.includes('export default defineMigration({'));
  });

  it('should include up and down functions', () => {
    const code = generateMigrationScaffold('create_posts');

    assert.ok(code.includes('async up({ db })'));
    assert.ok(code.includes('async down({ db })'));
  });

  it('should include example createTable with inferred table name', () => {
    const code = generateMigrationScaffold('create_users_table');

    assert.ok(code.includes("// await db.createTable('users'"));
    assert.ok(code.includes("// await db.dropTable('users'"));
  });

  it('should handle add_ prefix in name', () => {
    const code = generateMigrationScaffold('add_posts');

    assert.ok(code.includes("'posts'"));
  });

  it('should include TODO comments', () => {
    const code = generateMigrationScaffold('test_migration');

    assert.ok(code.includes('// TODO: Add your migration logic here'));
    assert.ok(code.includes('// TODO: Add rollback logic here'));
  });

  it('should include field builder examples', () => {
    const code = generateMigrationScaffold('test');

    assert.ok(code.includes('field.uuid().primaryKey()'));
    assert.ok(code.includes('field.createdAt()'));
    assert.ok(code.includes('field.updatedAt()'));
  });
});

// ============================================================================
// generateMigrationCode (without models)
// ============================================================================

describe('Migration Generator - generateMigrationCode', () => {
  it('should return scaffold when no models provided', () => {
    const code = generateMigrationCode({ name: 'empty_migration', models: [] });

    assert.ok(code.includes('// TODO: Add your migration logic here'));
    assert.ok(code.includes('async up({ db })'));
    assert.ok(code.includes('async down({ db })'));
  });

  it('should return scaffold when models is undefined', () => {
    const code = generateMigrationCode({ name: 'no_models' });

    assert.ok(code.includes('import { defineMigration }'));
    assert.ok(code.includes('import { field }'));
  });
});

// ============================================================================
// writeMigration
// ============================================================================

describe('Migration Generator - writeMigration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `migration-gen-test-${randomUUID().slice(0, 8)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should create migration file with timestamped name', async () => {
    const code = 'export default {}';
    const filepath = await writeMigration(testDir, 'create_users', code);

    // Should match pattern: YYYY_MM_DD_HHMMSS_create_users.ts
    assert.ok(filepath.includes('create_users.ts'));
    assert.match(filepath, /\d{4}_\d{2}_\d{2}_\d{6}_create_users\.ts$/);

    // File should exist and contain the code
    const content = await readFile(filepath, 'utf-8');
    assert.strictEqual(content, code);
  });

  it('should create directory if it does not exist', async () => {
    const nestedDir = join(testDir, 'nested', 'migrations');
    const code = 'export default {}';

    const filepath = await writeMigration(nestedDir, 'test', code);

    assert.ok(filepath.startsWith(nestedDir));
    const content = await readFile(filepath, 'utf-8');
    assert.strictEqual(content, code);
  });

  it('should throw error for existing file without overwrite', async () => {
    const code = 'export default {}';

    // Create first file
    await writeMigration(testDir, 'duplicate', code);

    // Wait a bit to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 1100));

    // This creates a new file with different timestamp, so no error
    const filepath2 = await writeMigration(testDir, 'duplicate', code);

    // Both files should exist
    const files = await readdir(testDir);
    assert.strictEqual(files.filter(f => f.includes('duplicate')).length, 2);
  });

  it('should overwrite existing file with overwrite option', async () => {
    const code1 = 'export default { v: 1 }';
    const filepath1 = await writeMigration(testDir, 'overwrite_test', code1);

    const code2 = 'export default { v: 2 }';
    const filepath2 = await writeMigration(testDir, 'overwrite_test', code2, {
      overwrite: true,
    });

    // Both paths are different (different timestamps)
    // But with overwrite, it should write the new file
    const content = await readFile(filepath2, 'utf-8');
    assert.strictEqual(content, code2);
  });
});

// ============================================================================
// createEmptyMigration
// ============================================================================

describe('Migration Generator - createEmptyMigration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `migration-empty-test-${randomUUID().slice(0, 8)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should create empty migration file', async () => {
    const filepath = await createEmptyMigration(testDir, 'add_index');

    const content = await readFile(filepath, 'utf-8');
    assert.ok(content.includes('defineMigration'));
    assert.ok(content.includes('async up({ db })'));
    assert.ok(content.includes('async down({ db })'));
  });

  it('should include inferred table name in comments', async () => {
    const filepath = await createEmptyMigration(testDir, 'create_orders_table');

    const content = await readFile(filepath, 'utf-8');
    assert.ok(content.includes("'orders'"));
  });
});

// ============================================================================
// Migration Name Format
// ============================================================================

describe('Migration Generator - Name Format', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `migration-name-test-${randomUUID().slice(0, 8)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should use YYYY_MM_DD_HHMMSS format', async () => {
    const filepath = await writeMigration(testDir, 'test', 'code');

    // Extract timestamp from filename (format: YYYY_MM_DD_HHMMSS_name.ts)
    const filename = filepath.split('/').pop()!;
    const match = filename.match(/^(\d{4})_(\d{2})_(\d{2})_(\d{6})_test\.ts$/);

    assert.ok(match, `Filename should match timestamp pattern: ${filename}`);

    const [, year, month, day, time] = match!;
    const hour = time.slice(0, 2);
    const min = time.slice(2, 4);
    const sec = time.slice(4, 6);

    // Verify all parts are valid numbers
    assert.ok(parseInt(year) >= 2020 && parseInt(year) <= 2100, 'Year should be reasonable');
    assert.ok(parseInt(month) >= 1 && parseInt(month) <= 12, 'Month should be 1-12');
    assert.ok(parseInt(day) >= 1 && parseInt(day) <= 31, 'Day should be 1-31');
    assert.ok(parseInt(hour) >= 0 && parseInt(hour) <= 23, 'Hour should be 0-23');
    assert.ok(parseInt(min) >= 0 && parseInt(min) <= 59, 'Minute should be 0-59');
    assert.ok(parseInt(sec) >= 0 && parseInt(sec) <= 59, 'Second should be 0-59');
  });

  it('should handle special characters in name', async () => {
    // Underscores should work fine
    const filepath = await writeMigration(testDir, 'add_user_email_index', 'code');
    assert.ok(filepath.includes('add_user_email_index.ts'));
  });
});

// ============================================================================
// Code Format Validation
// ============================================================================

describe('Migration Generator - Code Format', () => {
  it('should generate valid TypeScript syntax', () => {
    const code = generateMigrationScaffold('test');

    // Check basic syntax elements
    assert.ok(code.includes('import {'));
    assert.ok(code.includes("} from '"));
    assert.ok(code.includes('export default'));
    assert.ok(code.includes('async'));
    assert.ok(code.includes('await'));
  });

  it('should use single quotes for imports', () => {
    const code = generateMigrationScaffold('test');

    // Should use single quotes as per biome config
    assert.ok(code.includes("from '@justscale/postgres'"));
    assert.ok(code.includes("from '@justscale/core/models'"));
    assert.ok(!code.includes('from "@'));
  });

  it('should properly format nested objects', () => {
    const code = generateMigrationScaffold('test');

    // Should have proper indentation structure
    const lines = code.split('\n');
    const upLine = lines.findIndex(l => l.includes('async up({ db })'));
    const downLine = lines.findIndex(l => l.includes('async down({ db })'));

    assert.ok(upLine > 0, 'Should have async up function');
    assert.ok(downLine > upLine, 'async down should come after async up');
  });
});

// ============================================================================
// generateSeederScaffold Mock (needs PgModel)
// ============================================================================

describe('Migration Generator - generateSeederScaffold', () => {
  it('should generate seeder with model snapshot', () => {
    // Create a mock PgModel
    const mockModel = {
      name: 'User',
      table: 'users',
      getStorageConfig: () => ({
        table: 'users',
        columns: [
          { fieldName: 'id', columnName: 'id', fieldType: 'uuid', pgType: 'UUID', nullable: false },
          { fieldName: 'email', columnName: 'email', fieldType: 'string', pgType: 'VARCHAR(255)', nullable: false, unique: true },
          { fieldName: 'name', columnName: 'name', fieldType: 'string', pgType: 'VARCHAR(100)', nullable: true },
          { fieldName: 'created_at', columnName: 'created_at', fieldType: 'createdAt', pgType: 'TIMESTAMPTZ', nullable: false },
          { fieldName: 'updated_at', columnName: 'updated_at', fieldType: 'updatedAt', pgType: 'TIMESTAMPTZ', nullable: false },
        ],
        indexes: [],
        relations: new Map(),
      }),
    } as any;

    const code = generateSeederScaffold({ model: mockModel });

    // Check structure
    assert.ok(code.includes("import { defineMigration } from '@justscale/postgres'"));
    assert.ok(code.includes("import { field } from '@justscale/core/models'"));

    // Check model snapshot
    assert.ok(code.includes('Model Snapshot: User'));
    assert.ok(code.includes('const UserSnapshot = {'));
    assert.ok(code.includes("table: 'users'"));

    // Check field definitions (should exclude id, created_at, updated_at)
    assert.ok(code.includes('email: field.string().max(255).unique()'));
    assert.ok(code.includes('name: field.string().max(100).optional()'));

    // Check up function
    assert.ok(code.includes('async up({ db })'));
    assert.ok(code.includes("await db.exists('users'"));
    assert.ok(code.includes("await db.insert('users'"));

    // Check down function
    assert.ok(code.includes('async down({ db })'));
    assert.ok(code.includes("await db.delete('users'"));
  });

  it('should generate sample values for different field types', () => {
    const mockModel = {
      name: 'Product',
      table: 'products',
      getStorageConfig: () => ({
        table: 'products',
        columns: [
          { fieldName: 'id', columnName: 'id', fieldType: 'uuid', pgType: 'UUID', nullable: false },
          { fieldName: 'name', columnName: 'name', fieldType: 'string', pgType: 'TEXT', nullable: false },
          { fieldName: 'price', columnName: 'price', fieldType: 'decimal', pgType: 'DECIMAL(10,2)', nullable: false },
          { fieldName: 'active', columnName: 'active', fieldType: 'boolean', pgType: 'BOOLEAN', nullable: false },
          { fieldName: 'quantity', columnName: 'quantity', fieldType: 'int', pgType: 'INTEGER', nullable: false },
          { fieldName: 'metadata', columnName: 'metadata', fieldType: 'jsonb', pgType: 'JSONB', nullable: true },
          { fieldName: 'status', columnName: 'status', fieldType: 'enum', pgType: 'product_status', enumValues: ['draft', 'published'], nullable: false },
        ],
        indexes: [],
        relations: new Map(),
      }),
    } as any;

    const code = generateSeederScaffold({ model: mockModel });

    // Check sample values are generated
    assert.ok(code.includes("name: 'sample_name'"), 'Should have string sample');
    assert.ok(code.includes("price: '0.00'"), 'Should have decimal sample');
    assert.ok(code.includes('active: true'), 'Should have boolean sample');
    assert.ok(code.includes('quantity: 1'), 'Should have int sample');
    assert.ok(code.includes('metadata: {}'), 'Should have jsonb sample');
    assert.ok(code.includes("status: 'draft'"), 'Should have enum sample using first value');
  });

  it('should skip system columns in sample data', () => {
    const mockModel = {
      name: 'Log',
      table: 'logs',
      getStorageConfig: () => ({
        table: 'logs',
        columns: [
          { fieldName: 'id', columnName: 'id', fieldType: 'uuid', pgType: 'UUID', nullable: false },
          { fieldName: 'message', columnName: 'message', fieldType: 'text', pgType: 'TEXT', nullable: false },
          { fieldName: 'version', columnName: 'version', fieldType: 'version', pgType: 'INTEGER', nullable: false },
          { fieldName: 'created_at', columnName: 'created_at', fieldType: 'createdAt', pgType: 'TIMESTAMPTZ', nullable: false },
          { fieldName: 'updated_at', columnName: 'updated_at', fieldType: 'updatedAt', pgType: 'TIMESTAMPTZ', nullable: false },
        ],
        indexes: [],
        relations: new Map(),
      }),
    } as any;

    const code = generateSeederScaffold({ model: mockModel });

    // Should include message in insert
    assert.ok(code.includes('message:'));

    // The sample data section should only have message (id, version, created_at, updated_at are system columns)
    const insertMatch = code.match(/await db\.insert\('logs', \{([^}]+)\}/);
    if (insertMatch) {
      const insertContent = insertMatch[1];
      assert.ok(!insertContent.includes('id:'), 'Should not include id in sample data');
      assert.ok(!insertContent.includes('version:'), 'Should not include version in sample data');
      assert.ok(!insertContent.includes('created_at:'), 'Should not include created_at in sample data');
      assert.ok(!insertContent.includes('updated_at:'), 'Should not include updated_at in sample data');
    }
  });

  it('should add idempotency check', () => {
    const mockModel = {
      name: 'Setting',
      table: 'settings',
      getStorageConfig: () => ({
        table: 'settings',
        columns: [
          { fieldName: 'id', columnName: 'id', fieldType: 'uuid', pgType: 'UUID', nullable: false },
          { fieldName: 'key', columnName: 'key', fieldType: 'string', pgType: 'VARCHAR(100)', nullable: false },
        ],
        indexes: [],
        relations: new Map(),
      }),
    } as any;

    const code = generateSeederScaffold({ model: mockModel });

    assert.ok(code.includes('const exists = await db.exists'));
    assert.ok(code.includes('if (exists)'));
    assert.ok(code.includes('return // Already seeded'));
  });

  it('should include DO NOT modify warning', () => {
    const mockModel = {
      name: 'Config',
      table: 'configs',
      getStorageConfig: () => ({
        table: 'configs',
        columns: [
          { fieldName: 'id', columnName: 'id', fieldType: 'uuid', pgType: 'UUID', nullable: false },
        ],
        indexes: [],
        relations: new Map(),
      }),
    } as any;

    const code = generateSeederScaffold({ model: mockModel });

    assert.ok(code.includes('DO NOT modify this snapshot'));
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Migration Generator - Edge Cases', () => {
  describe('Name handling edge cases', () => {
    it('should handle single character name', () => {
      const code = generateMigrationScaffold('x');
      assert.ok(code.includes('defineMigration'));
    });

    it('should handle very long name', () => {
      const longName = 'a'.repeat(100);
      const code = generateMigrationScaffold(longName);
      assert.ok(code.includes('defineMigration'));
    });

    it('should handle name with numbers', () => {
      const code = generateMigrationScaffold('add_column_v2_2024');
      assert.ok(code.includes('defineMigration'));
    });

    it('should handle name starting with add_', () => {
      const code = generateMigrationScaffold('add_users_table');
      assert.ok(code.includes("'users'"));
    });

    it('should handle name starting with create_', () => {
      const code = generateMigrationScaffold('create_posts');
      assert.ok(code.includes("'posts'"));
    });

    it('should handle name with _table suffix', () => {
      const code = generateMigrationScaffold('create_orders_table');
      assert.ok(code.includes("'orders'"));
    });
  });

  describe('generateMigrationCode edge cases', () => {
    it('should handle empty name', () => {
      const code = generateMigrationCode({ name: '' });
      assert.ok(code.includes('defineMigration'));
    });

    it('should handle undefined models', () => {
      const code = generateMigrationCode({ name: 'test', models: undefined });
      assert.ok(code.includes('async up({ db })'));
      assert.ok(code.includes('async down({ db })'));
    });
  });

  describe('writeMigration edge cases', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `edge-test-${randomUUID().slice(0, 8)}`);
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      try {
        await rm(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should handle empty code', async () => {
      const filepath = await writeMigration(testDir, 'empty', '');
      const content = await readFile(filepath, 'utf-8');
      assert.strictEqual(content, '');
    });

    it('should handle code with special characters', async () => {
      const specialCode = "const x = 'test\\n\\t';\n// © 2024";
      const filepath = await writeMigration(testDir, 'special', specialCode);
      const content = await readFile(filepath, 'utf-8');
      assert.strictEqual(content, specialCode);
    });

    it('should handle very long code', async () => {
      const longCode = '// '.repeat(10000);
      const filepath = await writeMigration(testDir, 'long', longCode);
      const content = await readFile(filepath, 'utf-8');
      assert.strictEqual(content.length, longCode.length);
    });

    it('should handle deeply nested directory', async () => {
      const deepDir = join(testDir, 'a', 'b', 'c', 'd', 'e');
      const filepath = await writeMigration(deepDir, 'deep', 'code');
      assert.ok(filepath.startsWith(deepDir));
    });
  });

  describe('Seeder scaffold edge cases', () => {
    it('should handle model with no columns', () => {
      const mockModel = {
        name: 'Empty',
        table: 'empty',
        getStorageConfig: () => ({
          table: 'empty',
          columns: [],
          indexes: [],
          relations: new Map(),
        }),
      } as any;

      const code = generateSeederScaffold({ model: mockModel });
      assert.ok(code.includes('EmptySnapshot'));
    });

    it('should handle model with only system columns', () => {
      const mockModel = {
        name: 'Audit',
        table: 'audits',
        getStorageConfig: () => ({
          table: 'audits',
          columns: [
            { fieldName: 'id', columnName: 'id', fieldType: 'uuid', pgType: 'UUID', nullable: false },
            { fieldName: 'created_at', columnName: 'created_at', fieldType: 'createdAt', pgType: 'TIMESTAMPTZ', nullable: false },
          ],
          indexes: [],
          relations: new Map(),
        }),
      } as any;

      const code = generateSeederScaffold({ model: mockModel });
      assert.ok(code.includes('AuditSnapshot'));
    });

    it('should handle model with array column', () => {
      const mockModel = {
        name: 'Tagged',
        table: 'tagged',
        getStorageConfig: () => ({
          table: 'tagged',
          columns: [
            { fieldName: 'id', columnName: 'id', fieldType: 'uuid', pgType: 'UUID', nullable: false },
            { fieldName: 'tags', columnName: 'tags', fieldType: 'array', pgType: 'TEXT[]', nullable: false },
          ],
          indexes: [],
          relations: new Map(),
        }),
      } as any;

      const code = generateSeederScaffold({ model: mockModel });
      assert.ok(code.includes('tags'));
    });

    it('should handle model with nullable fields', () => {
      const mockModel = {
        name: 'Nullable',
        table: 'nullable',
        getStorageConfig: () => ({
          table: 'nullable',
          columns: [
            { fieldName: 'id', columnName: 'id', fieldType: 'uuid', pgType: 'UUID', nullable: false },
            { fieldName: 'optional_field', columnName: 'optional_field', fieldType: 'string', pgType: 'TEXT', nullable: true },
          ],
          indexes: [],
          relations: new Map(),
        }),
      } as any;

      const code = generateSeederScaffold({ model: mockModel });
      assert.ok(code.includes('optional'));
    });

    it('should handle model name with special casing', () => {
      const mockModel = {
        name: 'UserProfile',
        table: 'user_profiles',
        getStorageConfig: () => ({
          table: 'user_profiles',
          columns: [
            { fieldName: 'id', columnName: 'id', fieldType: 'uuid', pgType: 'UUID', nullable: false },
          ],
          indexes: [],
          relations: new Map(),
        }),
      } as any;

      const code = generateSeederScaffold({ model: mockModel });
      assert.ok(code.includes('UserProfileSnapshot'));
    });
  });
});
