/**
 * PostgreSQL Database Helpers
 *
 * Utilities for creating and managing database schema from PgModels.
 * Primarily for testing; can be reused by migration tooling.
 *
 * @example
 * ```typescript
 * import { createPgDatabase, dropPgDatabase } from '@justscale/postgres';
 *
 * // Create tables for models
 * await createPgDatabase(client, PgUser, PgPost, PgTag);
 *
 * // Drop tables (in reverse order to handle FK dependencies)
 * await dropPgDatabase(client, PgUser, PgPost, PgTag);
 * ```
 */

import { defineService } from '@justscale/core';
import type {
  AnyModel,
  Condition,
  FieldBuilder,
  FieldDef,
  FieldDefs,
} from '@justscale/core/models';
import { AbstractPostgresClient } from './client/client.js';
import type {
  Database,
  ForeignKeyOptions,
  IndexOptions,
  MigrationContext,
  TableAlterationBuilder,
  TableColumns,
} from './migration/migration-schema.js';
import type { Snapshot, SnapshotRepository } from './migration/migration-snapshot.js';
import { SNAPSHOT_FIELDS, SNAPSHOT_TABLE } from './migration/migration-snapshot.js';
import type {
  ColumnMeta,
  IndexConfig,
  PgModel,
  StorageConfig,
} from './model/pg-model.js';
import { PgQueryCompiler } from './query/query-compiler.js';
import { toSnakeCase } from './utils/naming.js';
import {
  AddForeignKey,
  AlterEnumAddValue,
  AlterTable,
  ColumnDef,
  CreateEnum,
  CreateIndex,
  CreateTable,
  DropConstraint,
  DropIndex,
  DropTable,
  DropType,
  RenameTable,
  type TableAlteration,
} from './sql/sql-ddl.js';


/**
 * Generate CREATE TABLE SQL from storage config.
 */
export function generateCreateTableSQL(config: StorageConfig): string {
  const lines: string[] = [];

  // System columns (always present)
  lines.push('  id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
  lines.push('  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  lines.push('  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  lines.push('  version INTEGER NOT NULL DEFAULT 1');

  if (config.storageMode === 'jsonb') {
    // JSONB mode: single data column
    const dataCol = config.dataColumn ?? 'data';
    lines.push(`  ${dataCol} JSONB NOT NULL DEFAULT '{}'`);
  } else {
    // Columnar mode: each field is a column
    for (const col of config.columns) {
      lines.push(generateColumnDef(col));
    }
  }

  // Build CREATE TABLE
  let sql = `CREATE TABLE IF NOT EXISTS ${config.table} (\n`;
  sql += lines.filter(l => l !== '').join(',\n');
  sql += '\n)';

  return sql;
}

/**
 * Generate column definition SQL.
 */
function generateColumnDef(col: ColumnMeta): string {
  // Skip system columns (handled separately)
  if (['id', 'createdAt', 'updatedAt', 'version'].includes(col.fieldName)) {
    return '';
  }

  const parts: string[] = [`  ${col.columnName}`];

  // Type
  parts.push(col.pgType);

  // Nullability
  if (!col.nullable) {
    parts.push('NOT NULL');
  }

  // Unique constraint
  if (col.unique) {
    parts.push('UNIQUE');
  }

  // Default value (from override or model field definition)
  if (col.override?.default) {
    parts.push(`DEFAULT ${col.override.default}`);
  } else if (col.defaultValue !== undefined) {
    if (typeof col.defaultValue === 'string') {
      parts.push(`DEFAULT '${col.defaultValue}'`);
    } else if (typeof col.defaultValue === 'number' || typeof col.defaultValue === 'boolean') {
      parts.push(`DEFAULT ${col.defaultValue}`);
    } else if (Array.isArray(col.defaultValue) && col.pgType.endsWith('[]')) {
      // PostgreSQL array literal for native array columns
      if (col.defaultValue.length === 0) {
        parts.push('DEFAULT \'{}\'');
      } else {
        const elements = col.defaultValue.map((v: unknown) =>
          typeof v === 'string' ? `"${v}"` : String(v)
        ).join(',');
        parts.push(`DEFAULT '{${elements}}'`);
      }
    } else if (typeof col.defaultValue === 'object') {
      parts.push(`DEFAULT '${JSON.stringify(col.defaultValue)}'`);
    }
  }

  return parts.join(' ');
}

/**
 * Generate CREATE INDEX SQL statements.
 */
export function generateIndexSQL(config: StorageConfig): string[] {
  const statements: string[] = [];

  // Auto-generated indexes
  statements.push(
    `CREATE INDEX IF NOT EXISTS idx_${config.table}_created_at ON ${config.table}(created_at)`,
  );
  statements.push(
    `CREATE INDEX IF NOT EXISTS idx_${config.table}_updated_at ON ${config.table}(updated_at)`,
  );

  if (config.storageMode === 'jsonb') {
    const dataCol = config.dataColumn ?? 'data';
    statements.push(
      `CREATE INDEX IF NOT EXISTS idx_${config.table}_${dataCol}_gin ON ${config.table} USING GIN (${dataCol})`,
    );
  }

  // Build field->column mapping for index generation
  // Maps both fieldName and fieldNameId (for ref fields) to the column name
  const fieldToColumn = new Map<string, string>();
  for (const col of config.columns) {
    fieldToColumn.set(col.fieldName, col.columnName);
    if (col.fieldType === 'ref') {
      fieldToColumn.set(col.fieldName + 'Id', col.columnName);
    }
  }

  // User-defined indexes
  for (const idx of config.indexes) {
    statements.push(generateIndexDef(config.table, idx, fieldToColumn));
  }

  // Indexes from column overrides
  for (const col of config.columns) {
    if (col.override?.index) {
      statements.push(
        `CREATE INDEX IF NOT EXISTS idx_${config.table}_${col.columnName} ON ${config.table}(${col.columnName})`,
      );
    }
  }

  return statements;
}

/**
 * Generate single CREATE INDEX statement.
 */
function generateIndexDef(table: string, idx: IndexConfig, fieldToColumn?: Map<string, string>): string {
  const name = idx.name ?? `idx_${table}_${idx.fields.join('_')}`;
  const unique = idx.unique ? 'UNIQUE ' : '';
  const using = idx.using ? ` USING ${idx.using}` : '';

  let columns: string;
  if (idx.expression) {
    columns = idx.expression;
  } else {
    columns = idx.fields
      .map(f => fieldToColumn?.get(f) ?? f)
      .join(', ');
  }

  let sql = `CREATE ${unique}INDEX IF NOT EXISTS ${name} ON ${table}${using} (${columns})`;

  if (idx.where) {
    sql += ` WHERE ${idx.where}`;
  }

  return sql;
}

/**
 * Generate DROP TABLE SQL.
 */
export function generateDropTableSQL(table: string): string {
  return `DROP TABLE IF EXISTS ${table} CASCADE`;
}


/**
 * Create / drop / truncate / recreate tables for a set of PgModels.
 *
 * All operations are idempotent where possible - `create` uses IF NOT EXISTS,
 * `drop` uses CASCADE, `truncate` is a no-op with an empty model list.
 */
export class PgDatabaseOps {
  constructor(private readonly client: AbstractPostgresClient) {}

  async create(...models: PgModel<AnyModel>[]): Promise<void> {
    for (const model of models) {
      const config = model.getStorageConfig();

      const createSQL = generateCreateTableSQL(config);
      await this.client.sql.unsafe(createSQL);

      for (const indexSQL of generateIndexSQL(config)) {
        await this.client.sql.unsafe(indexSQL);
      }
    }
  }

  async drop(...models: PgModel<AnyModel>[]): Promise<void> {
    // Drop in reverse order (handles FK dependencies)
    for (const model of [...models].reverse()) {
      await this.client.sql.unsafe(generateDropTableSQL(model.table));
    }
  }

  async truncate(...models: PgModel<AnyModel>[]): Promise<void> {
    if (models.length === 0) return;
    const tables = models.map((m) => m.table).join(', ');
    await this.client.sql.unsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  }

  async recreate(...models: PgModel<AnyModel>[]): Promise<void> {
    await this.drop(...models);
    await this.create(...models);
  }
}

export class PgDatabaseOpsService extends defineService({
  inject: { client: AbstractPostgresClient },
  factory: ({ client }): PgDatabaseOps => new PgDatabaseOps(client),
}) {}


/**
 * Table alteration builder for migrations.
 */
class TableAlterationBuilderImpl implements TableAlterationBuilder {
  private alterations: TableAlteration[] = [];

  addColumn(name: string, column: FieldBuilder<unknown>): void {
    const fieldDef = column.build();
    const columnName = toSnakeCase(name);
    this.alterations.push({
      type: 'addColumn',
      column: ColumnDef.fromField(columnName, fieldDef),
    });

    // If using backfill (no permanent default), drop the default after column is added
    // This makes the column NOT NULL with existing rows backfilled, but no default for new inserts
    if (
      fieldDef.backfillValue !== undefined &&
      fieldDef.defaultValue === undefined
    ) {
      this.alterations.push({ type: 'dropDefault', column: columnName });
    }
  }

  dropColumn(name: string): void {
    this.alterations.push({ type: 'dropColumn', name: toSnakeCase(name) });
  }

  renameColumn(from: string, to: string): void {
    this.alterations.push({
      type: 'renameColumn',
      from: toSnakeCase(from),
      to: toSnakeCase(to),
    });
  }

  alterType(name: string, newType: string): void {
    this.alterations.push({ type: 'alterType', column: toSnakeCase(name), newType });
  }

  setNullable(name: string): void {
    this.alterations.push({ type: 'dropNotNull', column: toSnakeCase(name) });
  }

  setNotNull(name: string): void {
    this.alterations.push({ type: 'setNotNull', column: toSnakeCase(name) });
  }

  setDefault(name: string, value: string): void {
    this.alterations.push({ type: 'setDefault', column: name, value });
  }

  dropDefault(name: string): void {
    this.alterations.push({ type: 'dropDefault', column: name });
  }

  addConstraint(name: string, expression: string): void {
    this.alterations.push({
      type: 'addConstraint',
      name,
      definition: expression,
    });
  }

  dropConstraint(name: string): void {
    this.alterations.push({ type: 'dropConstraint', name });
  }

  getAlterations(): TableAlteration[] {
    return this.alterations;
  }
}

/**
 * PostgreSQL Database implementation for migrations.
 * Uses SQL DDL AST for structured SQL generation.
 */
export class PgDatabase implements Database {
  private client: AbstractPostgresClient;

  constructor(client: AbstractPostgresClient) {
    this.client = client;
  }

  async createTable(name: string, columns: TableColumns): Promise<void> {
    const colDefs: ColumnDef[] = [];
    const enumsToCreate: Array<{ name: string; values: string[] }> = [];

    for (const [colName, builder] of Object.entries(columns)) {
      const fieldDef = builder.build();

      // Collect enums to create
      if (
        fieldDef.type === 'enum' &&
        fieldDef.enumName &&
        fieldDef.enumValues
      ) {
        enumsToCreate.push({
          name: fieldDef.enumName,
          values: [...fieldDef.enumValues],
        });
      }

      colDefs.push(ColumnDef.fromField(toSnakeCase(colName), fieldDef));
    }

    // Create enums first
    for (const enumDef of enumsToCreate) {
      const exists = await this.hasType(enumDef.name);
      if (!exists) {
        const createEnumNode = new CreateEnum(enumDef.name, enumDef.values);
        await this.client.sql.unsafe(createEnumNode.toSql());
      }
    }

    // Create table using AST
    const createTableNode = new CreateTable(name, colDefs);
    await this.client.sql.unsafe(createTableNode.toSql());

    // Create indexes for indexed fields
    for (const [colName, builder] of Object.entries(columns)) {
      const fieldDef = builder.build();
      if (fieldDef.indexed && !fieldDef.primaryKey && !fieldDef.unique) {
        await this.createIndex(name, [toSnakeCase(colName)]);
      }
    }
  }

  async dropTable(name: string): Promise<void> {
    const node = new DropTable(name);
    await this.client.sql.unsafe(node.toSql());
  }

  async dropTableIfExists(name: string): Promise<void> {
    const node = new DropTable(name, true, true);
    await this.client.sql.unsafe(node.toSql());
  }

  async renameTable(from: string, to: string): Promise<void> {
    const node = new RenameTable(from, to);
    await this.client.sql.unsafe(node.toSql());
  }

  async hasTable(name: string): Promise<boolean> {
    const [result] = await this.client.sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${name}
      ) as exists
    `;
    return result?.exists ?? false;
  }

  async alterTable(
    name: string,
    callback: (table: TableAlterationBuilder) => void,
  ): Promise<void> {
    const builder = new TableAlterationBuilderImpl();
    callback(builder);

    const alterations = builder.getAlterations();
    if (alterations.length === 0) return;

    const node = new AlterTable(name, alterations);
    await this.client.sql.unsafe(node.toSql());
  }

  async createIndex(
    table: string,
    columns: string | string[],
    options?: IndexOptions,
  ): Promise<void> {
    const cols = (Array.isArray(columns) ? columns : [columns]).map(toSnakeCase);
    const node = new CreateIndex(table, cols, {
      name: options?.name,
      unique: options?.unique,
      using: options?.using,
      where: options?.where,
      concurrently: options?.concurrently,
    });
    await this.client.sql.unsafe(node.toSql());
  }

  async dropIndex(name: string): Promise<void> {
    const node = new DropIndex(name);
    await this.client.sql.unsafe(node.toSql());
  }

  async dropIndexIfExists(name: string): Promise<void> {
    const node = new DropIndex(name, true);
    await this.client.sql.unsafe(node.toSql());
  }

  async addForeignKey(
    table: string,
    column: string,
    references: { table: string; column?: string },
    options?: ForeignKeyOptions,
  ): Promise<void> {
    const node = new AddForeignKey(table, {
      constraintName: options?.name,
      column: toSnakeCase(column),
      referencesTable: references.table,
      referencesColumn: references.column
        ? toSnakeCase(references.column)
        : undefined,
      onDelete: options?.onDelete,
      onUpdate: options?.onUpdate,
    });
    await this.client.sql.unsafe(node.toSql());
  }

  async dropForeignKey(table: string, name: string): Promise<void> {
    const node = new DropConstraint(table, name);
    await this.client.sql.unsafe(node.toSql());
  }

  async addUnique(
    table: string,
    columns: string | string[],
    name?: string,
  ): Promise<void> {
    const cols = (Array.isArray(columns) ? columns : [columns]).map(toSnakeCase);
    const constraintName = name ?? `uq_${table}_${cols.join('_')}`;
    const node = new AlterTable(table, [
      {
        type: 'addConstraint',
        name: constraintName,
        definition: `UNIQUE (${cols.join(', ')})`,
      },
    ]);
    await this.client.sql.unsafe(node.toSql());
  }

  async dropUnique(table: string, name: string): Promise<void> {
    const node = new DropConstraint(table, name);
    await this.client.sql.unsafe(node.toSql());
  }

  async addCheck(
    table: string,
    name: string,
    expression: string,
  ): Promise<void> {
    const node = new AlterTable(table, [
      {
        type: 'addConstraint',
        name,
        definition: `CHECK (${expression})`,
      },
    ]);
    await this.client.sql.unsafe(node.toSql());
  }

  async dropCheck(table: string, name: string): Promise<void> {
    const node = new DropConstraint(table, name);
    await this.client.sql.unsafe(node.toSql());
  }

  async createType(name: string, values: string[]): Promise<void> {
    // Idempotent: skip if the enum already exists. Matches the auto-skip
    // behavior in createTable() for auto-generated enums, and survives
    // partial-failure recovery where a prior migration created the type
    // but didn't record successfully.
    if (await this.hasType(name)) return;
    const node = new CreateEnum(name, values);
    await this.client.sql.unsafe(node.toSql());
  }

  async addTypeValue(
    name: string,
    value: string,
    options?: { after?: string; before?: string },
  ): Promise<void> {
    const node = new AlterEnumAddValue(name, value, options);
    await this.client.sql.unsafe(node.toSql());
  }

  async dropType(name: string): Promise<void> {
    const node = new DropType(name);
    await this.client.sql.unsafe(node.toSql());
  }

  async dropTypeIfExists(name: string): Promise<void> {
    const node = new DropType(name, true);
    await this.client.sql.unsafe(node.toSql());
  }

  async hasType(name: string): Promise<boolean> {
    // Postgres stores unquoted identifiers lowercase; matching the check
    // against lowercased name mirrors that normalization so PascalCase
    // callers (e.g. `createType('OrderStatus', ...)`) see the existing
    // `orderstatus` row in pg_type.
    const [result] = await this.client.sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = ${name.toLowerCase()}
      ) as exists
    `;
    return result?.exists ?? false;
  }

  async raw(sql: string): Promise<void> {
    await this.client.sql.unsafe(sql);
  }

  async query<T = unknown>(sql: string): Promise<T[]> {
    return (await this.client.sql.unsafe(sql)) as T[];
  }

  // --- DATA OPERATIONS ---

  async insert<T extends Record<string, unknown>>(
    table: string,
    data: T,
  ): Promise<T & { id: string }> {
    const keys = Object.keys(data);
    const values = Object.values(data) as (
      | string
      | number
      | boolean
      | null
      | Date
    )[];

    if (keys.length === 0) {
      // Insert with defaults only
      const sql = `INSERT INTO ${table} DEFAULT VALUES RETURNING *`;
      const [result] = await this.client.sql.unsafe(sql);
      return result as unknown as T & { id: string };
    }

    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const columns = keys.join(', ');

    const sql = `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`;
    const [result] = await this.client.sql.unsafe(sql, values);
    return result as unknown as T & { id: string };
  }

  async insertMany<T extends Record<string, unknown>>(
    table: string,
    data: T[],
  ): Promise<Array<T & { id: string }>> {
    if (data.length === 0) return [];

    const results: Array<T & { id: string }> = [];
    for (const row of data) {
      const result = await this.insert(table, row);
      results.push(result);
    }
    return results;
  }

  async update(
    table: string,
    data: Record<string, unknown>,
    where: Record<string, unknown>,
  ): Promise<number> {
    const setKeys = Object.keys(data);
    const whereKeys = Object.keys(where);

    if (setKeys.length === 0) return 0;
    if (whereKeys.length === 0) {
      throw new Error(
        'update() requires a where clause to prevent accidental full-table updates',
      );
    }

    const allValues = [...Object.values(data), ...Object.values(where)] as (
      | string
      | number
      | boolean
      | null
      | Date
    )[];
    const setClause = setKeys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const whereClause = whereKeys
      .map((k, i) => `${k} = $${setKeys.length + i + 1}`)
      .join(' AND ');

    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
    const result = await this.client.sql.unsafe(sql, allValues);
    return result.count ?? 0;
  }

  async delete(table: string, where: Record<string, unknown>): Promise<number> {
    const keys = Object.keys(where);

    if (keys.length === 0) {
      throw new Error(
        'delete() requires a where clause to prevent accidental full-table deletes',
      );
    }

    const values = Object.values(where) as (
      | string
      | number
      | boolean
      | null
      | Date
    )[];
    const whereClause = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');

    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
    const result = await this.client.sql.unsafe(sql, values);
    return result.count ?? 0;
  }

  async exists(
    table: string,
    where: Record<string, unknown>,
  ): Promise<boolean> {
    const keys = Object.keys(where);
    const values = Object.values(where) as (
      | string
      | number
      | boolean
      | null
      | Date
    )[];

    if (keys.length === 0) {
      const sql = `SELECT EXISTS (SELECT 1 FROM ${table} LIMIT 1) as exists`;
      const [result] = await this.client.sql.unsafe(sql);
      return result?.exists ?? false;
    }

    const whereClause = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
    const sql = `SELECT EXISTS (SELECT 1 FROM ${table} WHERE ${whereClause}) as exists`;
    const [result] = await this.client.sql.unsafe(sql, values);
    return result?.exists ?? false;
  }

  async find<T = Record<string, unknown>>(
    table: string,
    where?: Record<string, unknown>,
  ): Promise<T[]> {
    if (!where || Object.keys(where).length === 0) {
      return (await this.client.sql.unsafe(`SELECT * FROM ${table}`)) as T[];
    }

    const keys = Object.keys(where);
    const values = Object.values(where) as (
      | string
      | number
      | boolean
      | null
      | Date
    )[];
    const whereClause = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');

    return (await this.client.sql.unsafe(
      `SELECT * FROM ${table} WHERE ${whereClause}`,
      values,
    )) as T[];
  }

  async findOne<T = Record<string, unknown>>(
    table: string,
    where: Record<string, unknown>,
  ): Promise<T | null> {
    const keys = Object.keys(where);
    const values = Object.values(where) as (
      | string
      | number
      | boolean
      | null
      | Date
    )[];

    if (keys.length === 0) {
      throw new Error('findOne() requires a where clause');
    }

    const whereClause = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
    const sql = `SELECT * FROM ${table} WHERE ${whereClause} LIMIT 1`;
    const results = (await this.client.sql.unsafe(sql, values)) as T[];
    return results[0] ?? null;
  }
}

/**
 * Create a Database instance for migrations.
 */
export function createMigrationDatabase(
  client: AbstractPostgresClient,
): Database {
  return new PgDatabase(client);
}

/**
 * DI-native service that resolves a `PgDatabase` bound to the injected
 * Postgres client. Non-DI callers (tests, standalone migration scripts)
 * use `createMigrationDatabase(client)` directly.
 */
export class PgDatabaseService extends defineService({
  inject: { client: AbstractPostgresClient },
  factory: ({ client }): Database => new PgDatabase(client),
}) {}


/**
 * Build field mapping from snapshot fields to snake_case column names.
 */
function buildFieldMap(
  fields: Record<string, FieldDef>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const fieldName of Object.keys(fields)) {
    // Convert camelCase to snake_case
    map[fieldName] = fieldName.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
  }
  return map;
}

/**
 * Snapshot repository implementation for migrations.
 *
 * Provides type-safe CRUD operations using Condition expressions.
 */
class SnapshotRepositoryImpl<T> implements SnapshotRepository<T> {
  private client: AbstractPostgresClient;
  private table: string;
  private compiler: PgQueryCompiler;

  constructor(client: AbstractPostgresClient, snapshot: Snapshot<T>) {
    this.client = client;
    this.table = snapshot[SNAPSHOT_TABLE];
    const fields = snapshot[SNAPSHOT_FIELDS];

    this.compiler = new PgQueryCompiler({
      storageMode: 'columnar',
      snakeCase: true,
      tableName: this.table,
      fieldMap: buildFieldMap(fields),
    });
  }

  async create(data: T): Promise<T & { id: string }> {
    const record = data as Record<string, unknown>;
    const keys = Object.keys(record);
    const values = Object.values(record) as (
      | string
      | number
      | boolean
      | null
      | Date
    )[];

    if (keys.length === 0) {
      const sql = `INSERT INTO ${this.table} DEFAULT VALUES RETURNING *`;
      const [result] = await this.client.sql.unsafe(sql);
      return result as unknown as T & { id: string };
    }

    // Convert camelCase keys to snake_case
    const columns = keys
      .map((k) => k.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`))
      .join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

    const sql = `INSERT INTO ${this.table} (${columns}) VALUES (${placeholders}) RETURNING *`;
    const [result] = await this.client.sql.unsafe(sql, values);
    return result as unknown as T & { id: string };
  }

  async createMany(data: T[]): Promise<Array<T & { id: string }>> {
    if (data.length === 0) return [];

    const results: Array<T & { id: string }> = [];
    for (const row of data) {
      const result = await this.create(row);
      results.push(result);
    }
    return results;
  }

  async update(where: Condition, data: Partial<T>): Promise<number> {
    const record = data as Record<string, unknown>;
    const setKeys = Object.keys(record);

    if (setKeys.length === 0) return 0;

    // Compile where clause
    const { text: whereText, values: whereValues } =
      this.compiler.compileWhere(where);

    // Build SET clause with snake_case columns
    const setValues = Object.values(record) as (
      | string
      | number
      | boolean
      | null
      | Date
    )[];
    const setClause = setKeys
      .map(
        (k, i) =>
          `${k.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`)} = $${i + 1}`,
      )
      .join(', ');

    // Reindex where placeholders
    const reindexedWhere = whereText.replace(
      /\$(\d+)/g,
      (_, num) => `$${Number.parseInt(num, 10) + setKeys.length}`,
    );

    const sql = `UPDATE ${this.table} SET ${setClause} WHERE ${reindexedWhere}`;
    const allValues = [...setValues, ...whereValues];
    const result = await this.client.sql.unsafe(
      sql,
      allValues as (string | number | boolean | null | Date)[],
    );
    return result.count ?? 0;
  }

  async delete(where: Condition): Promise<number> {
    const { text, values } = this.compiler.compileWhere(where);
    const sql = `DELETE FROM ${this.table} WHERE ${text}`;
    const result = await this.client.sql.unsafe(
      sql,
      values as (string | number | boolean | null | Date)[],
    );
    return result.count ?? 0;
  }

  async exists(where: Condition): Promise<boolean> {
    const { text, values } = this.compiler.compileWhere(where);
    const sql = `SELECT EXISTS (SELECT 1 FROM ${this.table} WHERE ${text}) as exists`;
    const [result] = await this.client.sql.unsafe(
      sql,
      values as (string | number | boolean | null | Date)[],
    );
    return result?.exists ?? false;
  }

  async find(where?: Condition): Promise<Array<T & { id: string }>> {
    if (!where) {
      return (await this.client.sql.unsafe(
        `SELECT * FROM ${this.table}`,
      )) as Array<T & { id: string }>;
    }

    const { text, values } = this.compiler.compileWhere(where);
    const sql = `SELECT * FROM ${this.table} WHERE ${text}`;
    return (await this.client.sql.unsafe(
      sql,
      values as (string | number | boolean | null | Date)[],
    )) as Array<T & { id: string }>;
  }

  async findOne(where: Condition): Promise<(T & { id: string }) | null> {
    const { text, values } = this.compiler.compileWhere(where);
    const sql = `SELECT * FROM ${this.table} WHERE ${text} LIMIT 1`;
    const results = (await this.client.sql.unsafe(
      sql,
      values as (string | number | boolean | null | Date)[],
    )) as Array<T & { id: string }>;
    return results[0] ?? null;
  }
}


/**
 * Migration context implementation.
 *
 * Provides both the raw database interface and typed snapshot repositories.
 */
/**
 * Build a `MigrationContext` bound to a concrete Postgres client. The
 * returned value is a plain object: migration files destructure
 * `{ db, repo }` from it, so the shape is as simple as possible (no
 * classes, no method binding traps).
 */
function buildMigrationContext(client: AbstractPostgresClient): MigrationContext {
  return {
    db: new PgDatabase(client),
    repo: <T, F extends FieldDefs>(snapshot: Snapshot<T, F>): SnapshotRepository<T> =>
      new SnapshotRepositoryImpl(client, snapshot),
  };
}

/**
 * DI token + service that provides a `MigrationContext` bound to the
 * injected Postgres client. Features that need a migration context
 * (or users writing custom migration tooling) resolve this token
 * instead of constructing one by hand.
 *
 * For non-DI callers (e.g. a standalone migration-runner script) the
 * plain factory `createMigrationContext(client)` is still exported.
 */
export class MigrationContextService extends defineService({
  inject: { client: AbstractPostgresClient },
  factory: ({ client }): MigrationContext => buildMigrationContext(client),
}) {}

/**
 * Create a migration context for running migrations. Non-DI callers
 * (e.g. the internal migration runner, test setups) use this; DI
 * callers inject `MigrationContextService` instead.
 */
export function createMigrationContext(
  client: AbstractPostgresClient,
): MigrationContext {
  return buildMigrationContext(client);
}
