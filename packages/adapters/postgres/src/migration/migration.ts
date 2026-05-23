import { defineService } from '@justscale/core';
import { AbstractPostgresClient } from '../client/client.js';
import { generateCreateTableSQL, generateIndexSQL } from '../pg-database.js';
import type {
  AnyPgModel,
  ColumnMeta,
  RelationConfig,
  StorageConfig,
} from '../model/pg-model.js';


/**
 * Column information from the database.
 */
export interface DbColumn {
  columnName: string
  dataType: string
  /**
   * PostgreSQL's `udt_name` - the underlying type name. For user-defined
   * types (enums, domains, composites) `dataType` is `'USER-DEFINED'`
   * and the actual type lives here; for built-ins it's the lower-case
   * form of `dataType` (e.g. `varchar`, `int4`) and usually redundant.
   */
  udtName: string
  isNullable: boolean
  columnDefault: string | null
  characterMaximumLength: number | null
  numericPrecision: number | null
  numericScale: number | null
}

/**
 * Index information from the database.
 */
export interface DbIndex {
  indexName: string
  columnNames: string[]
  isUnique: boolean
  isPrimary: boolean
}

/**
 * Foreign key information from the database.
 */
export interface DbForeignKey {
  constraintName: string
  columnName: string
  foreignTable: string
  foreignColumn: string
  onDelete: string
  onUpdate: string
}

/**
 * Enum type information from the database.
 */
export interface DbEnum {
  typeName: string
  values: string[]
}

/**
 * Table schema from the database.
 */
export interface DbTableSchema {
  tableName: string
  columns: DbColumn[]
  indexes: DbIndex[]
  foreignKeys: DbForeignKey[]
}

/**
 * Types of schema changes.
 */
export type ChangeType =
  | 'create_enum'
  | 'alter_enum'
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'alter_column_type'
  | 'alter_column_nullable'
  | 'alter_column_default'
  | 'add_index'
  | 'drop_index'
  | 'add_foreign_key'
  | 'drop_foreign_key'
  | 'create_junction_table';

/**
 * A single schema change.
 */
export interface SchemaChange {
  type: ChangeType
  table: string
  column?: string
  index?: string
  constraint?: string
  from?: string
  to?: string
  sql: string
  /** Priority for ordering (lower = earlier). Enums first, then tables, then FKs */
  priority: number
}

export interface Migration {
  changes: SchemaChange[]
  sql: string
  hasChanges: boolean
}

/**
 * Options for `PgSchemaIntrospection.apply` / `.sync`.
 */
export interface SyncOptions {
  /**
   * Allow destructive DDL (`drop_column`, `drop_table`, `drop_foreign_key`,
   * `drop_index`) to execute.
   *
   * Defaults to `false`. When `false`, attempting to apply a migration that
   * contains destructive changes throws a `DestructiveMigrationError`,
   * forcing the caller to explicitly acknowledge the risk.
   *
   * This matters because `sync()` diffs models vs live DB state: any column
   * the DB has but the model doesn't becomes a `drop_column` - wiring this
   * to a CLI path (or a dev auto-sync) without thinking is silent data
   * loss waiting to happen. Pass `true` in tests / intentional
   * hand-written migrations where you know the drop is wanted.
   */
  allowDestructive?: boolean
}

/**
 * Change types that destroy data or constraints. If any of these appear in
 * a Migration and `allowDestructive` is not set, `apply()` refuses to run.
 */
const DESTRUCTIVE_CHANGE_TYPES: ReadonlySet<ChangeType> = new Set<ChangeType>([
  'drop_table',
  'drop_column',
  'drop_index',
  'drop_foreign_key',
]);

/**
 * Thrown when `apply()` / `sync()` is asked to execute a Migration that
 * contains destructive DDL without `allowDestructive: true`.
 */
export class DestructiveMigrationError extends Error {
  readonly destructiveChanges: SchemaChange[];
  constructor(destructiveChanges: SchemaChange[]) {
    const summary = destructiveChanges
      .map((c) => `  - ${c.type} ${c.table}${c.column ? '.' + c.column : ''}${c.index ? ' [' + c.index + ']' : ''}`)
      .join('\n');
    super(
      `Refusing to apply destructive migration (${destructiveChanges.length} change(s)):\n` +
      summary +
      '\n\n' +
      'This migration would DROP columns / tables / indexes / foreign keys. ' +
      'That is almost always wrong in production - a removed model field or ' +
      'out-of-band DB column silently becomes data loss.\n\n' +
      'If this is intentional (test fixture, hand-written migration), pass ' +
      '`{ allowDestructive: true }` to acknowledge the footgun.',
    );
    this.name = 'DestructiveMigrationError';
    this.destructiveChanges = destructiveChanges;
  }
}

/**
 * Return the destructive subset of a Migration's changes, or [].
 */
function findDestructiveChanges(migration: Migration): SchemaChange[] {
  return migration.changes.filter((c) => DESTRUCTIVE_CHANGE_TYPES.has(c.type));
}

/**
 * True if `value` is a SyncOptions object and not an AnyPgModel. We use the
 * presence of `getStorageConfig` as the discriminator - PgModels always
 * have it; plain options objects never do.
 */
function isSyncOptions(value: unknown): value is SyncOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getStorageConfig?: unknown }).getStorageConfig !== 'function'
  );
}

export interface SchemaRecord {
  id: string
  name: string
  appliedAt: Date
  sql: string
  checksum: string
}


/**
 * Schema introspection + migration generation bound to a Postgres client.
 *
 * Reads live database state, diffs against PgModel definitions, and can
 * apply the resulting SQL. Pure-function siblings (`diffSchema`,
 * `printMigration`, `generate{ForeignKey,Junction,Enum}SQL`) live at
 * module scope - they don't touch the DB.
 */
export class PgSchemaIntrospection {
  constructor(private readonly client: AbstractPostgresClient) {}

  /** All enum types in the `public` schema, grouped by name. */
  async enumTypes(): Promise<DbEnum[]> {
    const rows = await this.client.sql<Array<{ typeName: string; enumValue: string }>>`
      SELECT
        t.typname as "typeName",
        e.enumlabel as "enumValue"
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder
    `;

    const enumMap = new Map<string, string[]>();
    for (const row of rows) {
      let values = enumMap.get(row.typeName);
      if (!values) {
        values = [];
        enumMap.set(row.typeName, values);
      }
      values.push(row.enumValue);
    }

    return Array.from(enumMap.entries()).map(([typeName, values]) => ({
      typeName,
      values,
    }));
  }

  /** Foreign keys on a specific table. */
  async foreignKeys(tableName: string): Promise<DbForeignKey[]> {
    const fks = await this.client.sql<DbForeignKey[]>`
      SELECT
        tc.constraint_name as "constraintName",
        kcu.column_name as "columnName",
        ccu.table_name as "foreignTable",
        ccu.column_name as "foreignColumn",
        rc.delete_rule as "onDelete",
        rc.update_rule as "onUpdate"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ${tableName}
    `;
    return fks as DbForeignKey[];
  }

  /** Full table schema, or null if the table doesn't exist. */
  async tableSchema(tableName: string): Promise<DbTableSchema | null> {
    const sql = this.client.sql;

    const [tableExists] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${tableName}
      ) as exists
    `;

    if (!tableExists?.exists) {
      return null;
    }

    const columns = await sql<DbColumn[]>`
      SELECT
        column_name as "columnName",
        data_type as "dataType",
        udt_name as "udtName",
        is_nullable = 'YES' as "isNullable",
        column_default as "columnDefault",
        character_maximum_length as "characterMaximumLength",
        numeric_precision as "numericPrecision",
        numeric_scale as "numericScale"
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${tableName}
      ORDER BY ordinal_position
    `;

    const indexes = await sql<
      Array<{
        indexName: string
        columnName: string
        isUnique: boolean
        isPrimary: boolean
      }>
    >`
      SELECT
        i.relname as "indexName",
        a.attname as "columnName",
        ix.indisunique as "isUnique",
        ix.indisprimary as "isPrimary"
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE t.relname = ${tableName}
        AND t.relkind = 'r'
      ORDER BY i.relname, a.attnum
    `;

    const indexMap = new Map<string, DbIndex>();
    for (const row of indexes) {
      let idx = indexMap.get(row.indexName);
      if (!idx) {
        idx = {
          indexName: row.indexName,
          columnNames: [],
          isUnique: row.isUnique,
          isPrimary: row.isPrimary,
        };
        indexMap.set(row.indexName, idx);
      }
      idx.columnNames.push(row.columnName);
    }

    const foreignKeys = await this.foreignKeys(tableName);

    return {
      tableName,
      columns: columns as DbColumn[],
      indexes: Array.from(indexMap.values()),
      foreignKeys,
    };
  }

  /**
   * Generate migration SQL by comparing models to the live database state.
   */
  async generate(...models: AnyPgModel[]): Promise<Migration> {
    const context: DiffContext = {
      modelToTable: new Map(),
      tableConfigs: new Map(),
      existingEnums: new Map(),
    };

    const enums = await this.enumTypes();
    for (const e of enums) {
      context.existingEnums.set(e.typeName, e.values);
    }

    const configs: StorageConfig[] = [];
    for (const model of models) {
      const config = model.getStorageConfig();
      context.modelToTable.set(model.name, config.table);
      context.tableConfigs.set(config.table, config);
      configs.push(config);
    }

    const allChanges: SchemaChange[] = [];

    const requiredEnums = extractRequiredEnums(configs);
    allChanges.push(...generateEnumChanges(requiredEnums, context.existingEnums));

    for (const model of models) {
      const config = model.getStorageConfig();
      const dbSchema = await this.tableSchema(config.table);
      allChanges.push(...diffSchema(config, dbSchema, context));
    }

    allChanges.sort((a, b) => a.priority - b.priority);

    const sql =
      allChanges.map((c) => c.sql).join(';\n') +
      (allChanges.length > 0 ? ';' : '');

    return {
      changes: allChanges,
      sql,
      hasChanges: allChanges.length > 0,
    };
  }

  /**
   * Apply a migration to the database (no tracking).
   *
   * By default, refuses to execute destructive DDL - pass
   * `{ allowDestructive: true }` to acknowledge the risk. See
   * `SyncOptions` and `DestructiveMigrationError`.
   */
  async apply(migration: Migration, options: SyncOptions = {}): Promise<void> {
    if (!migration.hasChanges) return;

    if (!options.allowDestructive) {
      const destructive = findDestructiveChanges(migration);
      if (destructive.length > 0) {
        throw new DestructiveMigrationError(destructive);
      }
    }

    await this.client.transaction(async () => {
      for (const change of migration.changes) {
        await this.client.sql.unsafe(change.sql);
      }
    });
  }

  /**
   * Generate + apply in one step (no tracking). Convenience for tests and
   * dev-mode schema sync; production code should use `MigrationRunner`
   * via `PostgresMigrationFeature` so changes are recorded.
   *
   * Safe by default: if the diff contains destructive changes (drop_column,
   * drop_table, drop_index, drop_foreign_key), `sync` throws a
   * `DestructiveMigrationError` unless the caller passes
   * `{ allowDestructive: true }` as the first argument.
   *
   * @example
   * ```typescript
   * // additive-only (safe default)
   * await intro.sync(PgUser, PgPost);
   *
   * // caller acknowledges destructive ops - tests / intentional migrations
   * await intro.sync({ allowDestructive: true }, PgUser);
   * ```
   */
  async sync(...args: [SyncOptions, ...AnyPgModel[]] | AnyPgModel[]): Promise<Migration> {
    let options: SyncOptions = {};
    let models: AnyPgModel[];
    if (args.length > 0 && isSyncOptions(args[0])) {
      options = args[0];
      models = args.slice(1) as AnyPgModel[];
    } else {
      models = args as AnyPgModel[];
    }

    const migration = await this.generate(...models);
    await this.apply(migration, options);
    return migration;
  }
}

export class PgSchemaIntrospectionService extends defineService({
  inject: { client: AbstractPostgresClient },
  factory: ({ client }): PgSchemaIntrospection => new PgSchemaIntrospection(client),
}) {}


/**
 * Context for diff operations - tracks all models for FK resolution.
 */
interface DiffContext {
  /** Map of model name -> table name */
  modelToTable: Map<string, string>
  /** Map of table name -> StorageConfig */
  tableConfigs: Map<string, StorageConfig>
  /** Existing enums in DB */
  existingEnums: Map<string, string[]>
}

/**
 * Extract required enums from model configs.
 */
function extractRequiredEnums(
  configs: StorageConfig[],
): Map<string, readonly string[]> {
  const enums = new Map<string, readonly string[]>();

  for (const config of configs) {
    for (const col of config.columns) {
      if (col.fieldType === 'enum' && col.enumValues) {
        // Use the pgType as the enum name (from field.enum('status', [...]))
        const enumName = col.pgType;
        if (enumName && enumName !== 'TEXT') {
          enums.set(enumName, col.enumValues);
        }
      }
    }
  }

  return enums;
}

/**
 * Generate enum type changes.
 */
function generateEnumChanges(
  requiredEnums: Map<string, readonly string[]>,
  existingEnums: Map<string, string[]>,
): SchemaChange[] {
  const changes: SchemaChange[] = [];

  for (const [enumName, requiredValues] of requiredEnums) {
    // Postgres lowercases unquoted identifiers, so look up case-insensitively
    const existingValues = existingEnums.get(enumName) ?? existingEnums.get(enumName.toLowerCase());

    if (!existingValues) {
      const quotedValues = requiredValues.map((v) => `'${v}'`).join(', ');
      changes.push({
        type: 'create_enum',
        table: '', // Enums are not table-specific
        sql: `CREATE TYPE ${enumName} AS ENUM (${quotedValues})`,
        priority: 1, // Enums must be created before tables that use them
      });
    } else {
      const missingValues = requiredValues.filter(
        (v) => !existingValues.includes(v),
      );

      for (const value of missingValues) {
        // Find the position to insert (after the last existing value before this one)
        const valueIndex = requiredValues.indexOf(value);
        let afterValue: string | undefined;

        for (let i = valueIndex - 1; i >= 0; i--) {
          if (existingValues.includes(requiredValues[i])) {
            afterValue = requiredValues[i];
            break;
          }
        }

        let sql: string;
        if (afterValue) {
          sql = `ALTER TYPE ${enumName} ADD VALUE '${value}' AFTER '${afterValue}'`;
        } else {
          // Insert at the beginning
          sql = `ALTER TYPE ${enumName} ADD VALUE '${value}' BEFORE '${existingValues[0]}'`;
        }

        changes.push({
          type: 'alter_enum',
          table: '',
          sql,
          priority: 2, // After enum creation, before tables
        });
      }
    }
  }

  return changes;
}

/**
 * Compare model schema to database schema and generate changes.
 */
export function diffSchema(
  config: StorageConfig,
  dbSchema: DbTableSchema | null,
  context?: DiffContext,
): SchemaChange[] {
  const changes: SchemaChange[] = [];

  if (!dbSchema) {
    const createSql = generateCreateTableSQL(config);
    changes.push({
      type: 'create_table',
      table: config.table,
      sql: createSql,
      priority: 10,
    });

    // Add indexes
    const indexStatements = generateIndexSQL(config);
    for (const indexSql of indexStatements) {
      const indexName = indexSql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)/)?.[1];
      changes.push({
        type: 'add_index',
        table: config.table,
        index: indexName,
        sql: indexSql,
        priority: 20,
      });
    }

    // Add foreign keys for ref columns
    if (context) {
      const fkChanges = generateForeignKeyChanges(config, [], context);
      changes.push(...fkChanges);
    }

    return changes;
  }

  const dbColumnMap = new Map<string, DbColumn>();
  for (const col of dbSchema.columns) {
    dbColumnMap.set(col.columnName, col);
  }

  const modelColumnMap = new Map<string, ColumnMeta>();

  const systemColumns: ColumnMeta[] = [
    {
      fieldName: 'id',
      columnName: 'id',
      fieldType: 'uuid',
      pgType: 'UUID',
      nullable: false,
      unique: false,
    },
    {
      fieldName: 'createdAt',
      columnName: 'created_at',
      fieldType: 'createdAt',
      pgType: 'TIMESTAMPTZ',
      nullable: false,
      unique: false,
    },
    {
      fieldName: 'updatedAt',
      columnName: 'updated_at',
      fieldType: 'updatedAt',
      pgType: 'TIMESTAMPTZ',
      nullable: false,
      unique: false,
    },
    {
      fieldName: 'version',
      columnName: 'version',
      fieldType: 'version',
      pgType: 'INTEGER',
      nullable: false,
      unique: false,
    },
  ];

  for (const col of systemColumns) {
    modelColumnMap.set(col.columnName, col);
  }

  if (config.storageMode === 'jsonb') {
    const dataCol = config.dataColumn ?? 'data';
    modelColumnMap.set(dataCol, {
      fieldName: 'data',
      columnName: dataCol,
      fieldType: 'jsonb',
      pgType: 'JSONB',
      nullable: false,
      unique: false,
    });
  } else {
    for (const col of config.columns) {
      modelColumnMap.set(col.columnName, col);
    }
  }

  for (const [colName, modelCol] of modelColumnMap) {
    if (!dbColumnMap.has(colName)) {
      changes.push({
        type: 'add_column',
        table: config.table,
        column: colName,
        sql: generateAddColumnSQL(config.table, modelCol),
        priority: 15,
      });
    }
  }

  for (const [colName] of dbColumnMap) {
    if (!modelColumnMap.has(colName)) {
      changes.push({
        type: 'drop_column',
        table: config.table,
        column: colName,
        sql: `ALTER TABLE ${config.table} DROP COLUMN ${colName}`,
        priority: 15,
      });
    }
  }

  for (const [colName, modelCol] of modelColumnMap) {
    const dbCol = dbColumnMap.get(colName);
    if (!dbCol) continue;

    // Check type change
    const normalizedDbType = normalizeDbType(dbCol);
    const normalizedModelType = normalizeModelType(modelCol.pgType);

    if (normalizedDbType !== normalizedModelType) {
      changes.push({
        type: 'alter_column_type',
        table: config.table,
        column: colName,
        from: normalizedDbType,
        to: normalizedModelType,
        sql: `ALTER TABLE ${config.table} ALTER COLUMN ${colName} TYPE ${modelCol.pgType}`,
        priority: 16,
      });
    }

    // Check nullable change
    if (dbCol.isNullable !== modelCol.nullable) {
      if (modelCol.nullable) {
        changes.push({
          type: 'alter_column_nullable',
          table: config.table,
          column: colName,
          from: 'NOT NULL',
          to: 'NULL',
          sql: `ALTER TABLE ${config.table} ALTER COLUMN ${colName} DROP NOT NULL`,
          priority: 16,
        });
      } else {
        changes.push({
          type: 'alter_column_nullable',
          table: config.table,
          column: colName,
          from: 'NULL',
          to: 'NOT NULL',
          sql: `ALTER TABLE ${config.table} ALTER COLUMN ${colName} SET NOT NULL`,
          priority: 16,
        });
      }
    }
  }

  const dbIndexNames = new Set(dbSchema.indexes.map((i) => i.indexName));
  const expectedIndexStatements = generateIndexSQL(config);

  for (const indexSql of expectedIndexStatements) {
    // Extract index name from SQL
    const match = indexSql.match(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/i,
    );
    if (match) {
      const indexName = match[1];
      if (!dbIndexNames.has(indexName)) {
        changes.push({
          type: 'add_index',
          table: config.table,
          index: indexName,
          sql: indexSql,
          priority: 20,
        });
      }
    }
  }

  if (context) {
    const fkChanges = generateForeignKeyChanges(
      config,
      dbSchema.foreignKeys,
      context,
    );
    changes.push(...fkChanges);

    // Check junction tables for refs fields
    const junctionChanges = generateJunctionTableChanges(config, context);
    changes.push(...junctionChanges);
  }

  return changes;
}

/**
 * Generate foreign key changes.
 */
function generateForeignKeyChanges(
  config: StorageConfig,
  existingFks: DbForeignKey[],
  context: DiffContext,
): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const existingFkMap = new Map<string, DbForeignKey>();

  for (const fk of existingFks) {
    existingFkMap.set(fk.columnName, fk);
  }

  for (const col of config.columns) {
    if (col.fieldType !== 'ref') continue;

    const relationConfig = config.relations.get(col.fieldName);
    const onDelete = relationConfig?.onDelete ?? 'NO ACTION';
    const onUpdate = relationConfig?.onUpdate ?? 'NO ACTION';

    // Skip if junction table is configured (handled separately)
    if (relationConfig?.junction) continue;

    // Resolve target table from model name
    let targetTable: string | undefined;
    if (col.refModelName) {
      targetTable = context.modelToTable.get(col.refModelName);
    }

    // If target not in context, skip (target model not in migration set)
    if (!targetTable) continue;

    const constraintName = `fk_${config.table}_${col.columnName}`;
    const existingFk = existingFkMap.get(col.columnName);

    if (!existingFk) {
      // Need to add FK constraint
      const sql =
        `ALTER TABLE ${config.table} ADD CONSTRAINT ${constraintName} ` +
        `FOREIGN KEY (${col.columnName}) REFERENCES ${targetTable}(id) ` +
        `ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;

      changes.push({
        type: 'add_foreign_key',
        table: config.table,
        column: col.columnName,
        constraint: constraintName,
        sql,
        priority: 30, // FKs after tables and indexes
      });
    } else {
      // FK exists - check if on delete/update rules match
      if (
        existingFk.onDelete !== onDelete ||
        existingFk.onUpdate !== onUpdate
      ) {
        // Drop and recreate with new rules
        changes.push({
          type: 'drop_foreign_key',
          table: config.table,
          constraint: existingFk.constraintName,
          sql: `ALTER TABLE ${config.table} DROP CONSTRAINT ${existingFk.constraintName}`,
          priority: 5, // Drop FKs first
        });

        const sql =
          `ALTER TABLE ${config.table} ADD CONSTRAINT ${constraintName} ` +
          `FOREIGN KEY (${col.columnName}) REFERENCES ${targetTable}(id) ` +
          `ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;

        changes.push({
          type: 'add_foreign_key',
          table: config.table,
          column: col.columnName,
          constraint: constraintName,
          sql,
          priority: 30,
        });
      }
    }
  }

  return changes;
}

/**
 * Generate junction table changes for refs (many-to-many) fields.
 */
function generateJunctionTableChanges(
  config: StorageConfig,
  context: DiffContext,
): SchemaChange[] {
  const changes: SchemaChange[] = [];

  for (const col of config.columns) {
    if (col.fieldType !== 'refs') continue;

    const relationConfig = config.relations.get(col.fieldName);
    if (!relationConfig?.junction) continue;

    // Resolve target table from model name
    let targetTable: string | undefined;
    if (col.refModelName) {
      targetTable = context.modelToTable.get(col.refModelName);
    }

    if (!targetTable) continue;

    const junctionTable = relationConfig.junction;
    const sourceTable = config.table;

    const junctionExists = context.tableConfigs.has(junctionTable);

    if (!junctionExists) {
      const sourceColName = `${sourceTable.replace(/s$/, '').replace(/ies$/, 'y')}_id`;
      const targetColName = `${targetTable.replace(/s$/, '').replace(/ies$/, 'y')}_id`;

      const sql = `
CREATE TABLE IF NOT EXISTS ${junctionTable} (
  ${sourceColName} UUID NOT NULL REFERENCES ${sourceTable}(id) ON DELETE CASCADE,
  ${targetColName} UUID NOT NULL REFERENCES ${targetTable}(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (${sourceColName}, ${targetColName})
);

CREATE INDEX IF NOT EXISTS idx_${junctionTable}_${sourceColName} ON ${junctionTable}(${sourceColName});
CREATE INDEX IF NOT EXISTS idx_${junctionTable}_${targetColName} ON ${junctionTable}(${targetColName})
      `.trim();

      changes.push({
        type: 'create_junction_table',
        table: junctionTable,
        sql,
        priority: 25, // After main tables, before FKs
      });
    }
  }

  return changes;
}

/**
 * Generate ADD COLUMN SQL.
 */
function generateAddColumnSQL(table: string, col: ColumnMeta): string {
  const parts: string[] = [`ALTER TABLE ${table} ADD COLUMN ${col.columnName}`];

  parts.push(col.pgType);

  if (!col.nullable) {
    // For adding NOT NULL columns, we need a default
    const defaultVal = getDefaultForType(col.pgType);
    parts.push(`NOT NULL DEFAULT ${defaultVal}`);
  }

  if (col.unique) {
    parts.push('UNIQUE');
  }

  if (col.override?.default) {
    parts.push(`DEFAULT ${col.override.default}`);
  }

  return parts.join(' ');
}

/**
 * Get a safe default value for a type when adding NOT NULL column.
 */
function getDefaultForType(pgType: string): string {
  const type = pgType.toUpperCase();

  if (
    type.startsWith('VARCHAR') ||
    type === 'TEXT' ||
    type.startsWith('CHAR')
  ) {
    return "''";
  }
  if (type === 'INTEGER' || type === 'SMALLINT' || type === 'BIGINT') {
    return '0';
  }
  if (
    type.startsWith('DECIMAL') ||
    type === 'REAL' ||
    type === 'DOUBLE PRECISION'
  ) {
    return '0';
  }
  if (type === 'BOOLEAN') {
    return 'FALSE';
  }
  if (type === 'UUID') {
    return 'gen_random_uuid()';
  }
  if (type === 'TIMESTAMPTZ' || type === 'TIMESTAMP') {
    return 'NOW()';
  }
  if (type === 'DATE') {
    return 'CURRENT_DATE';
  }
  if (type === 'TIME') {
    return 'CURRENT_TIME';
  }
  if (type === 'JSONB' || type === 'JSON') {
    return "'{}'";
  }
  if (type === 'BYTEA') {
    return "''::bytea";
  }
  if (type.endsWith('[]')) {
    return "'{}'";
  }

  return "''";
}

/**
 * Normalize database type for comparison.
 */
function normalizeDbType(col: DbColumn): string {
  const type = col.dataType.toUpperCase();

  // User-defined types (enums, domains, composites) - compare by the
  // actual type name in udt_name. Without this, every diff pass re-emits
  // ALTER COLUMN TYPE on every enum column.
  if (type === 'USER-DEFINED') {
    return col.udtName.toUpperCase();
  }

  // Handle character types
  if (type === 'CHARACTER VARYING') {
    return col.characterMaximumLength
      ? `VARCHAR(${col.characterMaximumLength})`
      : 'TEXT';
  }
  if (type === 'CHARACTER') {
    return col.characterMaximumLength
      ? `CHAR(${col.characterMaximumLength})`
      : 'CHAR(1)';
  }

  // Handle numeric types
  if (type === 'NUMERIC' || type === 'DECIMAL') {
    if (col.numericPrecision && col.numericScale !== null) {
      return `DECIMAL(${col.numericPrecision},${col.numericScale})`;
    }
    return 'DECIMAL';
  }

  // Handle timestamp
  if (type === 'TIMESTAMP WITH TIME ZONE') {
    return 'TIMESTAMPTZ';
  }
  if (type === 'TIMESTAMP WITHOUT TIME ZONE') {
    return 'TIMESTAMP';
  }

  // Handle arrays
  if (type === 'ARRAY') {
    return 'ARRAY';
  }

  return type;
}

/**
 * Normalize model type for comparison.
 */
function normalizeModelType(pgType: string): string {
  return pgType.toUpperCase();
}

/**
 * Generate a checksum for migration SQL.
 */
function generateChecksum(sql: string): string {
  let hash = 0;
  for (let i = 0; i < sql.length; i++) {
    const char = sql.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}


/**
 * SQL to create the migrations tracking table.
 */
export const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sql TEXT NOT NULL,
  checksum VARCHAR(16) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_migrations_applied_at ON _migrations(applied_at);
`;

/**
 * Schema runner that tracks applied schema changes from PgModels.
 * For file-based migrations, use MigrationRunner from migration-runner.ts.
 */
export class SchemaRunner {
  private client: AbstractPostgresClient;
  private initialized = false;

  constructor(client: AbstractPostgresClient) {
    this.client = client;
  }

  /**
   * Initialize the migrations table.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await this.client.sql.unsafe(MIGRATIONS_TABLE_SQL);
    this.initialized = true;
  }

  /**
   * Get all applied migrations.
   */
  async getApplied(): Promise<SchemaRecord[]> {
    await this.init();

    const rows = await this.client.sql<SchemaRecord[]>`
      SELECT
        id,
        name,
        applied_at as "appliedAt",
        sql,
        checksum
      FROM _migrations
      ORDER BY applied_at ASC
    `;

    return rows as SchemaRecord[];
  }

  /**
   * Check if a migration has been applied.
   */
  async isApplied(name: string): Promise<boolean> {
    await this.init();

    const [row] = await this.client.sql`
      SELECT 1 FROM _migrations WHERE name = ${name}
    `;

    return !!row;
  }

  /**
   * Apply a migration with tracking.
   *
   * @param migration - Migration to apply
   * @param name - Unique name for this migration
   */
  async apply(migration: Migration, name: string): Promise<void> {
    if (!migration.hasChanges) {
      return;
    }

    await this.init();

    if (await this.isApplied(name)) {
      throw new Error(`Migration "${name}" has already been applied`);
    }

    const checksum = generateChecksum(migration.sql);

    await this.client.transaction(async () => {
      for (const change of migration.changes) {
        await this.client.sql.unsafe(change.sql);
      }

      await this.client.sql`
        INSERT INTO _migrations (name, sql, checksum)
        VALUES (${name}, ${migration.sql}, ${checksum})
      `;
    });
  }

  /**
   * Generate and apply a migration for models.
   *
   * @param name - Migration name
   * @param models - PgModels to sync
   */
  async migrate(name: string, ...models: AnyPgModel[]): Promise<Migration> {
    const migration = await new PgSchemaIntrospection(this.client).generate(...models);

    if (migration.hasChanges) {
      await this.apply(migration, name);
    }

    return migration;
  }

  /**
   * Get pending changes without applying.
   */
  async pending(...models: AnyPgModel[]): Promise<Migration> {
    return new PgSchemaIntrospection(this.client).generate(...models);
  }
}

/**
 * DI-native service that resolves a `SchemaRunner` bound to the
 * injected Postgres client. Non-DI callers (tests, standalone scripts)
 * use `new SchemaRunner(client)` directly.
 */
export class SchemaRunnerService extends defineService({
  inject: { client: AbstractPostgresClient },
  factory: ({ client }): SchemaRunner => new SchemaRunner(client),
}) {}


/**
 * Print migration SQL to console (for review before applying).
 */
export function printMigration(migration: Migration): void {
  if (!migration.hasChanges) {
    console.log('No schema changes needed.');
    return;
  }

  console.log(`Schema changes (${migration.changes.length}):\n`);
  for (const change of migration.changes) {
    console.log(`-- ${change.type}${change.column ? `: ${change.column}` : ''}`);
    console.log(`${change.sql};\n`);
  }
}

/**
 * Generate SQL to add a foreign key constraint.
 */
export function generateForeignKeySQL(
  table: string,
  column: string,
  foreignTable: string,
  foreignColumn = 'id',
  config?: RelationConfig,
): string {
  const constraintName = `fk_${table}_${column}`;
  const onDelete = config?.onDelete ?? 'NO ACTION';
  const onUpdate = config?.onUpdate ?? 'NO ACTION';

  return (
    `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} ` +
    `FOREIGN KEY (${column}) REFERENCES ${foreignTable}(${foreignColumn}) ` +
    `ON DELETE ${onDelete} ON UPDATE ${onUpdate}`
  );
}

/**
 * Generate SQL to create a junction table for many-to-many.
 */
export function generateJunctionTableSQL(
  junctionTable: string,
  table1: string,
  table2: string,
  column1 = `${table1.replace(/s$/, '')}_id`,
  column2 = `${table2.replace(/s$/, '')}_id`,
): string {
  return `
CREATE TABLE IF NOT EXISTS ${junctionTable} (
  ${column1} UUID NOT NULL REFERENCES ${table1}(id) ON DELETE CASCADE,
  ${column2} UUID NOT NULL REFERENCES ${table2}(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (${column1}, ${column2})
);

CREATE INDEX IF NOT EXISTS idx_${junctionTable}_${column1} ON ${junctionTable}(${column1});
CREATE INDEX IF NOT EXISTS idx_${junctionTable}_${column2} ON ${junctionTable}(${column2})
  `.trim();
}

/**
 * Generate SQL to create an enum type.
 */
export function generateEnumSQL(enumName: string, values: string[]): string {
  const quotedValues = values.map((v) => `'${v}'`).join(', ');
  return `CREATE TYPE ${enumName} AS ENUM (${quotedValues})`;
}

/**
 * Generate SQL to add a value to an existing enum.
 */
export function generateAddEnumValueSQL(
  enumName: string,
  value: string,
  after?: string,
): string {
  if (after) {
    return `ALTER TYPE ${enumName} ADD VALUE '${value}' AFTER '${after}'`;
  }
  return `ALTER TYPE ${enumName} ADD VALUE '${value}'`;
}
