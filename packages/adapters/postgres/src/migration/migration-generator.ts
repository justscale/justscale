/**
 * Migration Code Generator
 *
 * Generates TypeScript migration files from PgModels or schema changes.
 * Produces human-readable code using the Database API (field builders).
 *
 * @example
 * ```typescript
 * import { generateMigrationCode, writeMigration } from '@justscale/postgres';
 *
 * // Generate from models
 * const code = generateMigrationCode({
 *   name: 'create_users_table',
 *   models: [PgUser],
 * });
 *
 * // Write to file
 * await writeMigration('./migrations', 'create_users_table', code);
 * // Creates: ./migrations/2024_01_15_143022_create_users_table.ts
 *
 * // Or generate empty scaffold
 * const scaffold = generateMigrationScaffold('add_email_index');
 * ```
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineService } from '@justscale/core';
import type { AnyModel } from '@justscale/core/models';
import { migrationName } from './migration-schema.js';
import {
  type SchemaChange,
  PgSchemaIntrospection,
  PgSchemaIntrospectionService,
} from './migration.js';
import type {
  AnyPgModel,
  ColumnMeta,
  PgModel,
  StorageConfig,
} from '../model/pg-model.js';


export interface GenerateMigrationOptions {
  /** Migration name (will be prefixed with timestamp) */
  name: string
  /** Models to generate migration for */
  models?: AnyPgModel[]
  /** Include down migration (default: true) */
  includeDown?: boolean
}

export interface WriteMigrationOptions {
  /** Overwrite existing file (default: false) */
  overwrite?: boolean
  /**
   * When true, `name` is treated as the final stamped name and used as the
   * filename as-is. When false (default), `name` is a slug and gets prefixed
   * with a fresh timestamp. Callers that stamp once and pass the same name
   * to both the code generator and the writer should set this to `true`.
   */
  stamped?: boolean
}

/**
 * Rewrite the `name: '...'` field inside a migration source string so it
 * matches the final on-disk filename. Idempotent when the value already
 * equals `finalName`. We target the first `name:` property in the
 * `defineMigration({ ... })` call - the shape the generator always emits.
 */
function rewriteEmbeddedName(code: string, finalName: string): string {
  return code.replace(
    /(\bname\s*:\s*)(['"])([^'"]*)\2/,
    (_match, head, quote) => `${head}${quote}${finalName}${quote}`,
  );
}


/**
 * Generate an empty migration scaffold.
 *
 * @example
 * ```typescript
 * const code = generateMigrationScaffold('add_user_avatar');
 * // Returns TypeScript code for an empty migration
 * ```
 */
export function generateMigrationScaffold(name: string): string {
  return `import { defineMigration } from '@justscale/postgres'
import { field } from '@justscale/core/models'

export default defineMigration({
  name: '${name}',
  async up({ db }) {
    // TODO: Add your migration logic here
    // Example:
    // await db.createTable('${toTableName(name)}', {
    //   id: field.uuid().primaryKey(),
    //   createdAt: field.createdAt(),
    //   updatedAt: field.updatedAt(),
    // })
  },

  async down({ db }) {
    // TODO: Add rollback logic here
    // Example:
    // await db.dropTable('${toTableName(name)}')
  },
})
`;
}


/**
 * Generate migration code from PgModels.
 *
 * @example
 * ```typescript
 * const code = generateMigrationCode({
 *   name: 'create_users_and_posts',
 *   models: [PgUser, PgPost],
 * });
 * ```
 */
export function generateMigrationCode(
  options: GenerateMigrationOptions,
): string {
  const { models = [], includeDown = true } = options;

  if (models.length === 0) {
    return generateMigrationScaffold(options.name);
  }

  const upStatements: string[] = [];
  const downStatements: string[] = [];

  // Collect all configs for FK resolution
  const modelToTable = new Map<string, string>();
  for (const model of models) {
    modelToTable.set(model.name, model.table);
  }

  // Generate statements for each model
  for (const model of models) {
    const config = model.getStorageConfig();
    upStatements.push(...generateCreateTableCode(config, modelToTable));
    downStatements.unshift(`await db.dropTable('${config.table}')`);
  }

  // Build the migration code
  const upCode = upStatements.join('\n\n    ');
  const downCode = includeDown
    ? downStatements.join('\n    ')
    : '// TODO: Add rollback logic';

  return `import { defineMigration } from '@justscale/postgres'

export default defineMigration({
  name: '${options.name}',
  async up({ db }) {
    ${upCode}
  },

  async down({ db }) {
    ${downCode}
  },
})
`;
}

/**
 * Generate createTable code for a storage config.
 */
function generateCreateTableCode(
  config: StorageConfig,
  modelToTable: Map<string, string>,
): string[] {
  const statements: string[] = [];

  // Build columns object
  const columnLines: string[] = [];

  // System columns first
  columnLines.push('id: field.uuid().primaryKey()');
  columnLines.push('createdAt: field.createdAt()');
  columnLines.push('updatedAt: field.updatedAt()');

  // User-defined columns
  for (const col of config.columns) {
    // Skip system columns (handled above)
    if (['id', 'createdAt', 'updatedAt', 'version'].includes(col.fieldName)) {
      continue;
    }

    const fieldCode = columnMetaToFieldCode(col);
    columnLines.push(`${col.fieldName}: ${fieldCode}`);
  }

  // Create table statement
  const columnsCode = columnLines.map((line) => `      ${line},`).join('\n');
  statements.push(`await db.createTable('${config.table}', {
${columnsCode}
    })`);

  // Add indexes
  for (const idx of config.indexes) {
    const columns = idx.fields;
    const columnsStr =
      columns.length === 1
        ? `'${columns[0]}'`
        : `[${columns.map((c: string) => `'${c}'`).join(', ')}]`;

    const options: string[] = [];
    if (idx.unique) options.push('unique: true');
    if (idx.using) options.push(`using: '${idx.using}'`);
    if (idx.where) options.push(`where: '${idx.where}'`);

    if (options.length > 0) {
      statements.push(
        `await db.createIndex('${config.table}', ${columnsStr}, { ${options.join(', ')} })`,
      );
    } else {
      statements.push(`await db.createIndex('${config.table}', ${columnsStr})`);
    }
  }

  // Add foreign keys
  for (const col of config.columns) {
    if (col.fieldType !== 'ref') continue;

    const relationConfig = config.relations.get(col.fieldName);
    if (relationConfig?.junction) continue; // Junction tables handled separately

    const targetTable = col.refModelName
      ? modelToTable.get(col.refModelName)
      : undefined;

    if (targetTable) {
      const options: string[] = [];
      if (relationConfig?.onDelete)
        options.push(`onDelete: '${relationConfig.onDelete}'`);
      if (relationConfig?.onUpdate)
        options.push(`onUpdate: '${relationConfig.onUpdate}'`);

      const optionsStr = options.length > 0 ? `, { ${options.join(', ')} }` : '';
      statements.push(
        `await db.addForeignKey('${config.table}', '${col.columnName}', { table: '${targetTable}' }${optionsStr})`,
      );
    }
  }

  return statements;
}

/**
 * Convert ColumnMeta to field builder code.
 */
function columnMetaToFieldCode(col: ColumnMeta): string {
  const parts: string[] = [];

  switch (col.fieldType) {
    case 'string':
      parts.push('field.string()');
      if (col.pgType.startsWith('VARCHAR(')) {
        const match = col.pgType.match(/VARCHAR\((\d+)\)/);
        if (match) parts.push(`.max(${match[1]})`);
      }
      break;

    case 'text':
      parts.push('field.text()');
      break;

    case 'int':
      parts.push('field.int()');
      break;

    case 'smallint':
      parts.push('field.smallint()');
      break;

    case 'bigint':
      parts.push('field.bigint()');
      break;

    case 'decimal': {
      const match = col.pgType.match(/DECIMAL\((\d+),(\d+)\)/);
      if (match) {
        parts.push(`field.decimal(${match[1]}, ${match[2]})`);
      } else {
        parts.push('field.decimal()');
      }
      break;
    }

    case 'float':
      parts.push('field.float()');
      break;

    case 'double':
      parts.push('field.double()');
      break;

    case 'boolean':
      parts.push('field.boolean()');
      break;

    case 'uuid':
      parts.push('field.uuid()');
      break;

    case 'timestamp':
      parts.push('field.timestamp()');
      break;

    case 'date':
      parts.push('field.date()');
      break;

    case 'time':
      parts.push('field.time()');
      break;

    case 'json':
      parts.push('field.json()');
      break;

    case 'jsonb':
      parts.push('field.jsonb()');
      break;

    case 'bytes':
      parts.push('field.bytes()');
      break;

    case 'enum':
      if (col.enumValues) {
        const values = col.enumValues.map((v) => `'${v}'`).join(', ');
        const enumName = col.pgType !== 'TEXT' ? col.pgType : col.fieldName;
        parts.push(`field.enum('${enumName}', [${values}] as const)`);
      } else {
        parts.push('field.string()');
      }
      break;

    case 'ref':
      // For refs, we'd need the target model - use uuid as fallback
      parts.push('field.uuid()');
      break;

    case 'refs':
      parts.push('field.uuid().array()');
      break;

    case 'array':
      parts.push('field.jsonb()'); // Arrays stored as JSONB
      break;

    default:
      parts.push('field.string()');
  }

  // Add modifiers
  if (col.nullable) {
    parts.push('.optional()');
  }

  if (col.unique) {
    parts.push('.unique()');
  }

  return parts.join('');
}


/**
 * Write migration code to a timestamped file. The app imports
 * `@justscale/postgres/virtual/migrations` once; the bundler plugin
 * generates the list of migration imports at build time by scanning
 * this directory. No hand-maintained barrel.
 *
 * @returns The full path to the created migration file
 */
export async function writeMigration(
  directory: string,
  name: string,
  code: string,
  options: WriteMigrationOptions = {},
): Promise<string> {
  await mkdir(directory, { recursive: true });

  const finalName = options.stamped ? name : migrationName(name);
  // Whenever the writer stamps (stamped: false) we may have been handed
  // code whose embedded `name: '...'` reflects the pre-stamp slug (or a
  // different stamping done moments earlier by the caller). The filename
  // and the embedded name MUST agree - the runner sorts and tracks by
  // `name`, so a mismatch shows up as a phantom "already applied" state.
  const finalCode = options.stamped
    ? code
    : rewriteEmbeddedName(code, finalName);
  const filename = `${finalName}.ts`;
  const filepath = join(directory, filename);

  if (!options.overwrite) {
    const { access } = await import('node:fs/promises');
    try {
      await access(filepath);
      throw new Error(`Migration file already exists: ${filepath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  await writeFile(filepath, finalCode, 'utf-8');
  return filepath;
}

/**
 * Generate and write a migration in one step.
 *
 * @example
 * ```typescript
 * const path = await createMigration('./migrations', {
 *   name: 'create_users_table',
 *   models: [PgUser],
 * });
 * ```
 */
export async function createMigration(
  directory: string,
  options: GenerateMigrationOptions,
): Promise<string> {
  // Stamp once so the filename and the emitted \`name:\` field match.
  const stamped = migrationName(options.name);
  const code = generateMigrationCode({ ...options, name: stamped });
  return writeMigration(directory, stamped, code, { stamped: true });
}

/**
 * Create an empty migration scaffold.
 *
 * @example
 * ```typescript
 * const path = await createEmptyMigration('./migrations', 'add_user_avatar');
 * ```
 */
export async function createEmptyMigration(
  directory: string,
  name: string,
): Promise<string> {
  const stamped = migrationName(name);
  const code = generateMigrationScaffold(stamped);
  return writeMigration(directory, stamped, code, { stamped: true });
}


export interface DiffMigrationOptions {
  /** Migration name */
  name: string
  /** Include down migration (default: true) */
  includeDown?: boolean
}

export interface DiffMigrationResult {
  /** Generated migration code */
  code: string
  /** Schema changes detected */
  changes: SchemaChange[]
  /** Whether there are any changes */
  hasChanges: boolean
}

/**
 * Generate migration code by diffing models against the database.
 *
 * Compares the current database schema to your PgModels and generates
 * migration code for all detected differences.
 *
 * @example
 * ```typescript
 * const result = await generateDiffMigration(client, [PgUser, PgPost], {
 *   name: 'sync_schema',
 * });
 *
 * if (result.hasChanges) {
 *   console.log('Changes detected:');
 *   for (const change of result.changes) {
 *     console.log(`  ${change.type}: ${change.table}`);
 *   }
 *
 *   await writeMigration('./migrations', 'sync_schema', result.code);
 * }
 * ```
 */
/**
 * Generate diff-based migration files by comparing PgModels to the live
 * database state. Backed by `PgSchemaIntrospection` for the DB read;
 * owns the code-emission half of `migrate make`.
 */
export class PgMigrationGenerator {
  constructor(private readonly introspection: PgSchemaIntrospection) {}

  /**
   * Generate migration code from models->DB diff.
   * Returns an empty-scaffold result when there are no changes.
   */
  async generateDiff(
    models: AnyPgModel[],
    options: DiffMigrationOptions,
  ): Promise<DiffMigrationResult> {
    const { includeDown = true } = options;

    const migration = await this.introspection.generate(...models);

    if (!migration.hasChanges) {
      return {
        code: generateMigrationScaffold(options.name),
        changes: [],
        hasChanges: false,
      };
    }

    const upStatements = migration.changes.map(schemaChangeToCode);
    const downStatements = includeDown
      ? migration.changes.map(schemaChangeToDownCode).reverse()
      : ['// TODO: Add rollback logic'];

    const upCode = upStatements.join('\n    ');
    const downCode = downStatements.filter(Boolean).join('\n    ');

    const code = `import { defineMigration } from '@justscale/postgres'

export default defineMigration({
  name: '${options.name}',
  async up({ db }) {
    ${upCode}
  },

  async down({ db }) {
    ${downCode}
  },
})
`;

    return { code, changes: migration.changes, hasChanges: true };
  }

  /** Generate + write a diff migration. Skips writing when there are no changes. */
  async createDiff(
    directory: string,
    models: AnyPgModel[],
    options: DiffMigrationOptions,
  ): Promise<DiffMigrationResult & { filepath?: string }> {
    // Stamp once so the filename and the emitted \`name:\` match.
    const stamped = migrationName(options.name);
    const result = await this.generateDiff(models, { ...options, name: stamped });
    if (!result.hasChanges) return result;
    const filepath = await writeMigration(directory, stamped, result.code, { stamped: true });
    return { ...result, filepath };
  }
}

export class PgMigrationGeneratorService extends defineService({
  inject: { introspection: PgSchemaIntrospectionService },
  factory: ({ introspection }): PgMigrationGenerator =>
    new PgMigrationGenerator(introspection),
}) {}

/**
 * Convert a SchemaChange to a migration up-statement.
 *
 * The SQL on `change.sql` is already authoritative - `applyMigration`
 * runs it verbatim against the client. Emitting the same SQL through
 * `db.raw(...)` in the generated file keeps behavior identical between
 * the "apply directly" and "generate file, review, apply" paths, and
 * sidesteps the regex round-trip that caused missing-CREATE-TYPE and
 * truncated ON-DELETE bugs.
 */
function schemaChangeToCode(change: SchemaChange): string {
  return `await db.raw(\`${escapeSql(change.sql)}\`)`;
}

/**
 * Convert a SchemaChange to a migration down-statement.
 *
 * Inversion uses the structured fields on `SchemaChange` (table, column,
 * index, constraint, from/to) - no SQL re-parsing. Cases that can't be
 * inverted without the original DDL (drop_table, drop_column,
 * drop_index, drop_foreign_key, alter_enum ADD VALUE) emit a comment
 * asking the author to fill it in.
 */
function schemaChangeToDownCode(change: SchemaChange): string {
  switch (change.type) {
    case 'create_enum': {
      const enumMatch = change.sql.match(/CREATE TYPE (\w+)/);
      return enumMatch
        ? `await db.dropType('${enumMatch[1]}')`
        : `// Manual: dropType for '${change.sql}'`;
    }

    case 'alter_enum':
      return '// Note: Cannot easily rollback enum value addition';

    case 'create_table':
      return `await db.dropTable('${change.table}')`;

    case 'drop_table':
      return `// Manual: recreate table '${change.table}' with its original schema.`;

    case 'add_column':
      return `await db.raw(\`ALTER TABLE ${change.table} DROP COLUMN ${change.column}\`)`;

    case 'drop_column':
      return `// Manual: re-add column '${change.column}' on table '${change.table}' with its original type.`;

    case 'alter_column_type':
      return `await db.raw(\`ALTER TABLE ${change.table} ALTER COLUMN ${change.column} TYPE ${change.from}\`)`;

    case 'alter_column_nullable':
      return change.to === 'NULL'
        ? `await db.raw(\`ALTER TABLE ${change.table} ALTER COLUMN ${change.column} SET NOT NULL\`)`
        : `await db.raw(\`ALTER TABLE ${change.table} ALTER COLUMN ${change.column} DROP NOT NULL\`)`;

    case 'alter_column_default':
      return `// Manual: restore previous DEFAULT on ${change.table}.${change.column} - inverse not tracked.`;

    case 'add_index':
      return change.index
        ? `await db.dropIndex('${change.index}')`
        : `// Manual: dropIndex for '${change.sql}'`;

    case 'drop_index':
      return `// Manual: recreate index '${change.index ?? '<unknown>'}'.`;

    case 'add_foreign_key':
      return change.constraint
        ? `await db.dropForeignKey('${change.table}', '${change.constraint}')`
        : `// Manual: dropForeignKey for '${change.sql}'`;

    case 'drop_foreign_key':
      return `// Manual: recreate foreign key '${change.constraint}' on '${change.table}'.`;

    case 'create_junction_table': {
      const tableMatch = change.sql.match(/CREATE TABLE.*?(\w+)/);
      if (tableMatch) {
        return `await db.dropTable('${tableMatch[1]}')`;
      }
      return '';
    }

    default:
      return '';
  }
}

/**
 * Escape SQL for template literal.
 */
function escapeSql(sql: string): string {
  return sql.replace(/`/g, '\\`').replace(/\$/g, '\\$');
}


/**
 * Convert migration name to likely table name.
 * 'create_users_table' -> 'users'
 * 'add_posts' -> 'posts'
 */
function toTableName(name: string): string {
  return name
    // Strip the `YYYY_MM_DD_HHMMSS_` timestamp prefix when present -
    // scaffolds receive the fully stamped name so \`name:\` and filename match.
    .replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, '')
    .replace(/^create_/, '')
    .replace(/_table$/, '')
    .replace(/^add_/, '');
}


export interface SeederScaffoldOptions {
  /** Model to seed */
  model: PgModel<AnyModel>
  /** Custom name (default: seed_<tablename>) */
  name?: string
}

/**
 * Generate a seeder migration scaffold with a model snapshot.
 *
 * The generated file contains:
 * 1. A snapshot of the model's fields at creation time
 * 2. Template code for inserting data using db.insert()
 *
 * This ensures the seeder works correctly even if the model evolves later.
 *
 * @example
 * ```typescript
 * const code = generateSeederScaffold({ model: PgUser });
 * await writeMigration('./migrations', 'seed_users', code);
 * ```
 */
export function generateSeederScaffold(options: SeederScaffoldOptions): string {
  const { model } = options;
  const config = model.getStorageConfig();
  const tableName = config.table;
  const modelName = model.name;
  const migrationNameValue = options.name ?? `seed_${tableName}`;

  // Generate the model snapshot - a local copy of the fields at this point in time
  const fieldLines: string[] = [];
  for (const col of config.columns) {
    // Skip system columns that are auto-generated
    if (
      ['id', 'created_at', 'updated_at', 'version'].includes(col.columnName)
    ) {
      continue;
    }

    const fieldCode = columnMetaToFieldCode(col);
    fieldLines.push(`    ${col.fieldName}: ${fieldCode},`);
  }

  const snapshotFields = fieldLines.join('\n');

  // Generate sample data based on field types
  const sampleDataLines: string[] = [];
  for (const col of config.columns) {
    if (
      ['id', 'created_at', 'updated_at', 'version'].includes(col.columnName)
    ) {
      continue;
    }

    const sampleValue = getSampleValue(col);
    sampleDataLines.push(`      ${col.fieldName}: ${sampleValue},`);
  }

  const sampleData = sampleDataLines.join('\n');

  return `import { defineMigration } from '@justscale/postgres'
import { field } from '@justscale/core/models'

/**
 * Model Snapshot: ${modelName}
 *
 * This is a snapshot of the ${modelName} model at the time this seeder was created.
 * It ensures this seeder continues to work even if the model changes later.
 *
 * DO NOT modify this snapshot - it represents the schema at migration time.
 */
const ${modelName}Snapshot = {
  table: '${tableName}',
  fields: {
${snapshotFields}
  },
}

export default defineMigration({
  name: '${migrationNameValue}',
  async up({ db }) {
    // Check if already seeded (idempotent)
    const exists = await db.exists('${tableName}', { /* unique identifier */ })
    if (exists) {
      return // Already seeded
    }

    // Insert seed data
    await db.insert('${tableName}', {
${sampleData}
    })

    // Or insert multiple records:
    // await db.insertMany('${tableName}', [
    //   { ... },
    //   { ... },
    // ])
  },

  async down({ db }) {
    // Remove seeded data
    await db.delete('${tableName}', { /* match the inserted records */ })
  },
})
`;
}

/**
 * Generate and write a seeder migration.
 *
 * @example
 * ```typescript
 * const result = await createSeederMigration('./migrations', PgUser, {
 *   name: 'seed_admin_users',
 * });
 * console.log('Created:', result.filepath);
 * ```
 */
export async function createSeederMigration(
  directory: string,
  model: PgModel<AnyModel>,
  options?: { name?: string },
): Promise<{ filepath: string; code: string }> {
  const config = model.getStorageConfig();
  const name = options?.name ?? `seed_${config.table}`;
  const stamped = migrationName(name);

  const code = generateSeederScaffold({ model, name: stamped });
  const filepath = await writeMigration(directory, stamped, code, { stamped: true });

  return { filepath, code };
}

/**
 * Get a sample value for a column based on its type.
 */
function getSampleValue(col: ColumnMeta): string {
  switch (col.fieldType) {
    case 'string':
    case 'text':
      return `'sample_${col.fieldName}'`;

    case 'int':
    case 'smallint':
    case 'bigint':
      return '1';

    case 'decimal':
    case 'float':
    case 'double':
      return "'0.00'";

    case 'boolean':
      return 'true';

    case 'uuid':
      return "'00000000-0000-0000-0000-000000000001'";

    case 'timestamp':
    case 'date':
    case 'createdAt':
    case 'updatedAt':
      return 'new Date()';

    case 'time':
      return "'12:00:00'";

    case 'json':
    case 'jsonb':
      return '{}';

    case 'bytes':
      return 'new Uint8Array()';

    case 'enum':
      if (col.enumValues && col.enumValues.length > 0) {
        return `'${col.enumValues[0]}'`;
      }
      return "'value'";

    case 'ref':
      return "'00000000-0000-0000-0000-000000000001' // FK reference";

    default:
      return `'TODO: set ${col.fieldName} value'`;
  }
}
