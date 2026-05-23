/**
 * SQL DDL Abstract Syntax Tree
 *
 * Structured representation of DDL statements (CREATE, ALTER, DROP).
 * Used by the migration system for type-safe SQL generation.
 */

import type { FieldDef } from '@justscale/core/models';

/**
 * Partial field definition for DDL generation.
 * Only requires `type`, all other properties are optional.
 */
export type PartialFieldDef = Partial<Omit<FieldDef, 'arrayOf'>> & {
  type: FieldDef['type']
  arrayOf?: PartialFieldDef
};


/**
 * Base class for all DDL nodes.
 */
export abstract class DdlNode {
  abstract toSql(): string;
}


/** Column constraint types */
export type ColumnConstraint =
  | { type: 'primaryKey' }
  | { type: 'notNull' }
  | { type: 'unique' }
  | { type: 'default'; value: string }
  | { type: 'check'; expression: string }
  | {
    type: 'references'
    table: string
    column: string
    onDelete?: string
    onUpdate?: string
  };

/**
 * Column definition for CREATE TABLE.
 */
export class ColumnDef extends DdlNode {
  constructor(
    public readonly name: string,
    public readonly dataType: string,
    public readonly constraints: ColumnConstraint[] = [],
  ) {
    super();
  }

  toSql(): string {
    const parts = [this.name, this.dataType];

    for (const c of this.constraints) {
      switch (c.type) {
        case 'primaryKey':
          parts.push('PRIMARY KEY');
          break;
        case 'notNull':
          parts.push('NOT NULL');
          break;
        case 'unique':
          parts.push('UNIQUE');
          break;
        case 'default':
          parts.push(`DEFAULT ${c.value}`);
          break;
        case 'check':
          parts.push(`CHECK (${c.expression})`);
          break;
        case 'references': {
          let ref = `REFERENCES ${c.table}(${c.column})`;
          if (c.onDelete) ref += ` ON DELETE ${c.onDelete}`;
          if (c.onUpdate) ref += ` ON UPDATE ${c.onUpdate}`;
          parts.push(ref);
          break;
        }
      }
    }

    return parts.join(' ');
  }

  /**
   * Create ColumnDef from a field definition.
   * Accepts partial FieldDef for convenience in tests and simple cases.
   */
  static fromField(name: string, field: PartialFieldDef): ColumnDef {
    const dataType = fieldToDataType(field);
    const constraints: ColumnConstraint[] = [];

    if (field.primaryKey) {
      constraints.push({ type: 'primaryKey' });
    }

    if (!field.optional && !field.primaryKey) {
      constraints.push({ type: 'notNull' });
    }

    if (field.unique && !field.primaryKey) {
      constraints.push({ type: 'unique' });
    }

    const defaultVal = getDefaultValue(field);
    if (defaultVal !== null) {
      constraints.push({ type: 'default', value: defaultVal });
    }

    return new ColumnDef(name, dataType, constraints);
  }
}


/**
 * CREATE TABLE statement.
 */
export class CreateTable extends DdlNode {
  constructor(
    public readonly tableName: string,
    public readonly columns: ColumnDef[],
    public readonly ifNotExists: boolean = false,
  ) {
    super();
  }

  toSql(): string {
    const ifNot = this.ifNotExists ? 'IF NOT EXISTS ' : '';
    const cols = this.columns.map((c) => `  ${c.toSql()}`).join(',\n');
    return `CREATE TABLE ${ifNot}${this.tableName} (\n${cols}\n)`;
  }
}


/**
 * DROP TABLE statement.
 */
export class DropTable extends DdlNode {
  constructor(
    public readonly tableName: string,
    public readonly ifExists: boolean = false,
    public readonly cascade: boolean = false,
  ) {
    super();
  }

  toSql(): string {
    const ifEx = this.ifExists ? 'IF EXISTS ' : '';
    const casc = this.cascade ? ' CASCADE' : '';
    return `DROP TABLE ${ifEx}${this.tableName}${casc}`;
  }
}


/** Alteration types */
export type TableAlteration =
  | { type: 'addColumn'; column: ColumnDef }
  | { type: 'dropColumn'; name: string }
  | { type: 'renameColumn'; from: string; to: string }
  | { type: 'alterType'; column: string; newType: string }
  | { type: 'setNotNull'; column: string }
  | { type: 'dropNotNull'; column: string }
  | { type: 'setDefault'; column: string; value: string }
  | { type: 'dropDefault'; column: string }
  | { type: 'addConstraint'; name: string; definition: string }
  | { type: 'dropConstraint'; name: string };

/**
 * ALTER TABLE statement.
 */
export class AlterTable extends DdlNode {
  constructor(
    public readonly tableName: string,
    public readonly alterations: TableAlteration[],
  ) {
    super();
  }

  toSql(): string {
    const parts: string[] = [];

    for (const alt of this.alterations) {
      switch (alt.type) {
        case 'addColumn':
          parts.push(`ADD COLUMN ${alt.column.toSql()}`);
          break;
        case 'dropColumn':
          parts.push(`DROP COLUMN ${alt.name}`);
          break;
        case 'renameColumn':
          parts.push(`RENAME COLUMN ${alt.from} TO ${alt.to}`);
          break;
        case 'alterType':
          parts.push(`ALTER COLUMN ${alt.column} TYPE ${alt.newType}`);
          break;
        case 'setNotNull':
          parts.push(`ALTER COLUMN ${alt.column} SET NOT NULL`);
          break;
        case 'dropNotNull':
          parts.push(`ALTER COLUMN ${alt.column} DROP NOT NULL`);
          break;
        case 'setDefault':
          parts.push(`ALTER COLUMN ${alt.column} SET DEFAULT ${alt.value}`);
          break;
        case 'dropDefault':
          parts.push(`ALTER COLUMN ${alt.column} DROP DEFAULT`);
          break;
        case 'addConstraint':
          parts.push(`ADD CONSTRAINT ${alt.name} ${alt.definition}`);
          break;
        case 'dropConstraint':
          parts.push(`DROP CONSTRAINT ${alt.name}`);
          break;
      }
    }

    // Each alteration is a separate statement for safety
    return parts.map((p) => `ALTER TABLE ${this.tableName} ${p}`).join(';\n');
  }
}


/**
 * RENAME TABLE statement.
 */
export class RenameTable extends DdlNode {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super();
  }

  toSql(): string {
    return `ALTER TABLE ${this.from} RENAME TO ${this.to}`;
  }
}


export interface CreateIndexOptions {
  name?: string
  unique?: boolean
  using?: string
  where?: string
  concurrently?: boolean
  ifNotExists?: boolean
}

/**
 * CREATE INDEX statement.
 */
export class CreateIndex extends DdlNode {
  constructor(
    public readonly tableName: string,
    public readonly columns: string[],
    public readonly options: CreateIndexOptions = {},
  ) {
    super();
  }

  toSql(): string {
    const {
      name = `idx_${this.tableName}_${this.columns.join('_')}`,
      unique = false,
      using,
      where,
      concurrently = false,
      ifNotExists = true,
    } = this.options;

    const parts = ['CREATE'];
    if (unique) parts.push('UNIQUE');
    parts.push('INDEX');
    if (concurrently) parts.push('CONCURRENTLY');
    if (ifNotExists) parts.push('IF NOT EXISTS');
    parts.push(name);
    parts.push('ON');
    parts.push(this.tableName);
    if (using) parts.push(`USING ${using}`);
    parts.push(`(${this.columns.join(', ')})`);
    if (where) parts.push(`WHERE ${where}`);

    return parts.join(' ');
  }
}


/**
 * DROP INDEX statement.
 */
export class DropIndex extends DdlNode {
  constructor(
    public readonly indexName: string,
    public readonly ifExists: boolean = false,
    public readonly concurrently: boolean = false,
  ) {
    super();
  }

  toSql(): string {
    const parts = ['DROP INDEX'];
    if (this.concurrently) parts.push('CONCURRENTLY');
    if (this.ifExists) parts.push('IF EXISTS');
    parts.push(this.indexName);
    return parts.join(' ');
  }
}


/**
 * CREATE TYPE ... AS ENUM statement.
 */
export class CreateEnum extends DdlNode {
  constructor(
    public readonly typeName: string,
    public readonly values: string[],
  ) {
    super();
  }

  toSql(): string {
    const quotedValues = this.values.map((v) => `'${v}'`).join(', ');
    return `CREATE TYPE ${this.typeName} AS ENUM (${quotedValues})`;
  }
}


/**
 * ALTER TYPE ... ADD VALUE statement.
 */
export class AlterEnumAddValue extends DdlNode {
  constructor(
    public readonly typeName: string,
    public readonly value: string,
    public readonly position?: { after?: string; before?: string },
  ) {
    super();
  }

  toSql(): string {
    let sql = `ALTER TYPE ${this.typeName} ADD VALUE '${this.value}'`;
    if (this.position?.after) {
      sql += ` AFTER '${this.position.after}'`;
    } else if (this.position?.before) {
      sql += ` BEFORE '${this.position.before}'`;
    }
    return sql;
  }
}


/**
 * DROP TYPE statement.
 */
export class DropType extends DdlNode {
  constructor(
    public readonly typeName: string,
    public readonly ifExists: boolean = false,
    public readonly cascade: boolean = false,
  ) {
    super();
  }

  toSql(): string {
    const parts = ['DROP TYPE'];
    if (this.ifExists) parts.push('IF EXISTS');
    parts.push(this.typeName);
    if (this.cascade) parts.push('CASCADE');
    return parts.join(' ');
  }
}


export interface ForeignKeyDef {
  constraintName?: string
  column: string
  referencesTable: string
  referencesColumn?: string
  onDelete?: string
  onUpdate?: string
}

/**
 * ADD FOREIGN KEY constraint.
 */
export class AddForeignKey extends DdlNode {
  constructor(
    public readonly tableName: string,
    public readonly fk: ForeignKeyDef,
  ) {
    super();
  }

  toSql(): string {
    const {
      constraintName = `fk_${this.tableName}_${this.fk.column}`,
      column,
      referencesTable,
      referencesColumn = 'id',
      onDelete,
      onUpdate,
    } = this.fk;

    let sql = `ALTER TABLE ${this.tableName} ADD CONSTRAINT ${constraintName} `;
    sql += `FOREIGN KEY (${column}) REFERENCES ${referencesTable}(${referencesColumn})`;
    if (onDelete) sql += ` ON DELETE ${onDelete}`;
    if (onUpdate) sql += ` ON UPDATE ${onUpdate}`;
    return sql;
  }
}


/**
 * DROP CONSTRAINT statement.
 */
export class DropConstraint extends DdlNode {
  constructor(
    public readonly tableName: string,
    public readonly constraintName: string,
    public readonly ifExists: boolean = false,
  ) {
    super();
  }

  toSql(): string {
    const ifEx = this.ifExists ? 'IF EXISTS ' : '';
    return `ALTER TABLE ${this.tableName} DROP CONSTRAINT ${ifEx}${this.constraintName}`;
  }
}


/**
 * Convert field type to PostgreSQL data type.
 */
function fieldToDataType(field: PartialFieldDef): string {
  switch (field.type) {
    case 'string':
      if (field.maxLength) return `VARCHAR(${field.maxLength})`;
      if (field.fixedLength) return `CHAR(${field.fixedLength})`;
      return 'TEXT';
    case 'text':
      return 'TEXT';
    case 'int':
      return 'INTEGER';
    case 'smallint':
      return 'SMALLINT';
    case 'bigint':
      return 'BIGINT';
    case 'decimal':
      if (field.precision !== undefined && field.scale !== undefined) {
        return `DECIMAL(${field.precision},${field.scale})`;
      }
      return 'DECIMAL';
    case 'float':
      return 'REAL';
    case 'double':
      return 'DOUBLE PRECISION';
    case 'boolean':
      return 'BOOLEAN';
    case 'uuid':
      return 'UUID';
    case 'timestamp':
    case 'createdAt':
    case 'updatedAt':
    case 'deletedAt':
      return 'TIMESTAMPTZ';
    case 'date':
      return 'DATE';
    case 'time':
      return 'TIME';
    case 'duration':
      return 'INTERVAL';
    case 'json':
      return 'JSON';
    case 'jsonb':
      return 'JSONB';
    case 'bytes':
      return 'BYTEA';
    case 'array':
      if (field.arrayOf) {
        return `${fieldToDataType(field.arrayOf)}[]`;
      }
      return 'JSONB';
    case 'enum':
      return field.enumName ?? 'TEXT';
    case 'object':
      return 'JSONB';
    case 'ref':
      return 'UUID';
    case 'refs':
      return 'UUID[]';
    case 'version':
      return 'INTEGER';
    default:
      return 'TEXT';
  }
}

/**
 * Get default value SQL for a field.
 * Also considers backfillValue for migrations (temporary defaults for existing rows).
 */
function getDefaultValue(field: PartialFieldDef): string | null {
  switch (field.type) {
    case 'createdAt':
    case 'updatedAt':
      return 'NOW()';
    case 'version':
      return '1';
    case 'uuid':
      if (field.primaryKey) return 'gen_random_uuid()';
      return null;
    default:
      break;
  }

  // Check defaultValue first, then backfillValue (for migrations)
  const rawValue = field.defaultValue ?? field.backfillValue;

  if (rawValue !== undefined) {
    const val = typeof rawValue === 'function' ? rawValue() : rawValue;

    if (val === null) return 'NULL';
    if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    if (typeof val === 'number') return String(val);
    if (val instanceof Date) return `'${val.toISOString()}'`;
    return String(val);
  }

  return null;
}


/** Create a CREATE TABLE statement from field definitions */
export function createTable(
  name: string,
  columns: Record<string, FieldDef>,
  ifNotExists = false,
): CreateTable {
  const colDefs = Object.entries(columns).map(([colName, field]) =>
    ColumnDef.fromField(colName, field),
  );
  return new CreateTable(name, colDefs, ifNotExists);
}

/** Create a DROP TABLE statement */
export function dropTable(
  name: string,
  ifExists = false,
  cascade = false,
): DropTable {
  return new DropTable(name, ifExists, cascade);
}

/** Create a CREATE INDEX statement */
export function createIndex(
  table: string,
  columns: string | string[],
  options?: CreateIndexOptions,
): CreateIndex {
  const cols = Array.isArray(columns) ? columns : [columns];
  return new CreateIndex(table, cols, options);
}

/** Create a CREATE ENUM statement */
export function createEnum(name: string, values: string[]): CreateEnum {
  return new CreateEnum(name, values);
}

/** Create an ADD FOREIGN KEY statement */
export function addForeignKey(table: string, fk: ForeignKeyDef): AddForeignKey {
  return new AddForeignKey(table, fk);
}
