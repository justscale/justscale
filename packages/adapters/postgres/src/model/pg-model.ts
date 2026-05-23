/**
 * PostgreSQL Storage Model
 *
 * Wraps a domain model (from defineModel) with PostgreSQL-specific storage configuration.
 * Separates domain concerns from storage concerns.
 *
 * @example
 * ```typescript
 * import { defineModel, field } from '@justscale/core/models';
 * import { createPgModel } from '@justscale/postgres';
 *
 * // Domain model (pure, no storage details)
 * class User extends defineModel({
 *   email: field.string().max(255).unique(),
 *   displayName: field.string().max(100),
 *   balance: field.decimal(10, 2).default('0.00'),
 * }) {}
 *
 * // Storage model (PG-specific mapping)
 * const PgUser = createPgModel(User, {
 *   table: 'users',
 *   overrides: {
 *     email: { unique: true, index: true },
 *     balance: { type: 'DECIMAL(10,2)' },
 *   },
 *   columnMap: {
 *     displayName: 'display_name',
 *   },
 * });
 *
 * // Create repository
 * const userRepo = PgUser.repository(client);
 *
 * // Query using domain model's field expressions
 * const users = await userRepo.find({
 *   where: User.fields.email.eq('test@example.com'),
 * });
 * ```
 */

import {
  type AnyModel,
  type FieldDef,
  type FieldDefs,
  type ModelClass,
  type ModelName,
  getModelFields,
  getModelName,
  registerModelForInjection,
  registerModelByName,
} from '@justscale/core/models';
import type { AbstractPostgresClient } from '../client/client.js';
import { PgRepository, type PgRepositoryOptions } from '../repository/pg-repository.js';
import type { StorageMode } from '../query/query-compiler.js';


/** Column override configuration */
export interface ColumnOverride {
  /** PostgreSQL type override (e.g., 'CITEXT', 'DECIMAL(10,2)') */
  type?: string
  /** Add UNIQUE constraint */
  unique?: boolean
  /** Create an index on this column */
  index?: boolean
  /** Default value (SQL expression) */
  default?: string
  /** Allow NULL (overrides field's optional setting) */
  nullable?: boolean
}

/** Foreign key behavior */
export interface RelationConfig {
  /** ON DELETE behavior */
  onDelete?: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION'
  /** ON UPDATE behavior */
  onUpdate?: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION'
  /** Junction table name for many-to-many relations */
  junction?: string
}

/** Index definition */
export interface IndexConfig {
  /** Fields to index */
  fields: string[]
  /** Index name (auto-generated if not provided) */
  name?: string
  /** Unique index */
  unique?: boolean
  /** Index method (btree, gin, gist, etc.) */
  using?: string
  /** Partial index WHERE clause */
  where?: string
  /** Expression index (e.g., for full-text search) */
  expression?: string
}

/** Options for creating a PostgreSQL storage model */
export interface PgModelOptions<F extends FieldDefs = FieldDefs> {
  /**
   * Table name in the database.
   * Defaults to snake_case of model name + 's' (e.g., 'User' -> 'users')
   */
  table?: string

  /**
   * Storage mode for the model.
   * - 'columnar': Each field maps to a column (default)
   * - 'jsonb': Fields stored in a JSONB data column
   */
  storageMode?: StorageMode

  /**
   * JSONB data column name (for 'jsonb' mode).
   * Default: 'data'
   */
  dataColumn?: string

  /**
   * Column overrides for specific fields.
   * Override inferred types, add constraints, etc.
   */
  overrides?: Partial<Record<keyof F, ColumnOverride>>

  /**
   * Relation configuration for ref/refs fields.
   * Define FK behavior, junction tables, etc.
   */
  relations?: Partial<Record<keyof F, RelationConfig>>

  /**
   * Additional indexes to create.
   */
  indexes?: IndexConfig[]

  /**
   * Fields to store as JSONB (even in columnar mode).
   * Useful for nested objects.
   */
  jsonb?: (keyof F)[]

  /**
   * Custom field to column name mapping.
   * Overrides automatic snake_case conversion.
   */
  columnMap?: Partial<Record<keyof F, string>>

  /**
   * Disable automatic snake_case conversion for column names.
   * Default: false (snake_case enabled)
   */
  preserveFieldNames?: boolean
}

/** Column metadata for a field (for migrations) */
export interface ColumnMeta {
  /** Field name in the model */
  fieldName: string
  /** Column name in the database */
  columnName: string
  /** Field type from the model */
  fieldType: string
  /** Inferred PostgreSQL type */
  pgType: string
  /** Whether the field is optional/nullable */
  nullable: boolean
  /** Whether the field has a unique constraint */
  unique: boolean
  /** Column override config (if any) */
  override?: ColumnOverride
  /** For ref/refs fields: the target model name */
  refModelName?: string
  /** For enum fields: the enum values */
  enumValues?: readonly string[]
  /** Default value from the model field definition */
  defaultValue?: unknown
}

/** Storage configuration for migrations */
export interface StorageConfig<_F extends FieldDefs = FieldDefs> {
  /** Table name */
  table: string
  /** Storage mode */
  storageMode: StorageMode
  /** JSONB data column (for jsonb mode) */
  dataColumn?: string
  /** All column metadata */
  columns: ColumnMeta[]
  /** Index definitions */
  indexes: IndexConfig[]
  /** Relation configurations */
  relations: Map<string, RelationConfig>
  /** Fields stored as JSONB */
  jsonbFields: Set<string>
}

/**
 * Non-generic base interface for PgModel.
 *
 * This interface captures the properties that don't depend on the model type,
 * allowing functions like generateMigration to accept any PgModel without
 * variance issues.
 */
export interface AnyPgModel {
  /** Model name */
  readonly name: string

  /** Table name */
  readonly table: string

  /** Storage mode */
  readonly storageMode: StorageMode

  /** Field to column name mapping */
  readonly columns: Record<string, string>

  /** Get column metadata for all fields (for migrations) */
  getColumnMeta(): ColumnMeta[]

  /** Get full storage configuration (for migrations) */
  getStorageConfig(): StorageConfig<FieldDefs>
}

/**
 * PostgreSQL storage model wrapper.
 *
 * Parameterized by the instance type to preserve named types in .d.ts output:
 * - `PgModel<User>` instead of `PgModel<{ email: string; ... }>`
 *
 * Use `ModelData<T>` to extract the data type when needed.
 */
export interface PgModel<T> extends AnyPgModel {
  /** The underlying domain model */
  readonly model: AnyModel

  /** Model name */
  readonly name: ModelName<T>

  /** Create a repository for this model */
  repository(client: AbstractPostgresClient): PgRepository<T>
}


function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function toTableName(modelName: string): string {
  // Convert PascalCase to snake_case and pluralize
  const snake = toSnakeCase(modelName).replace(/^_/, '');
  // Simple pluralization (add 's', handle 'y' -> 'ies')
  if (snake.endsWith('y')) {
    return `${snake.slice(0, -1)}ies`;
  }
  return `${snake}s`;
}

/** Map field type to PostgreSQL type */
function fieldTypeToPgType(fieldDef: FieldDef): string {
  switch (fieldDef.type) {
    case 'string':
      if ('maxLength' in fieldDef && fieldDef.maxLength) {
        return `VARCHAR(${fieldDef.maxLength})`;
      }
      if ('fixedLength' in fieldDef && fieldDef.fixedLength) {
        return `CHAR(${fieldDef.fixedLength})`;
      }
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
      if ('precision' in fieldDef && 'scale' in fieldDef) {
        return `DECIMAL(${fieldDef.precision},${fieldDef.scale})`;
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
      // Get element type (stored as 'arrayOf' by field.array())
      if ('arrayOf' in fieldDef && fieldDef.arrayOf) {
        const elementPgType = fieldTypeToPgType(
          fieldDef.arrayOf as FieldDef,
        );
        return `${elementPgType}[]`;
      }
      return 'JSONB'; // Fallback for unknown arrays
    case 'enum':
      // Use the enum name if provided
      if ('enumName' in fieldDef && fieldDef.enumName) {
        return fieldDef.enumName as string;
      }
      return 'TEXT';
    case 'object':
      return 'JSONB';
    case 'ref':
      return 'UUID'; // Foreign key
    case 'refs':
      return 'UUID[]'; // Array of foreign keys (or junction table)
    case 'version':
      return 'INTEGER';
    default:
      return 'TEXT';
  }
}


/**
 * Create a PostgreSQL storage model from a domain model.
 *
 * The returned PgModel is parameterized by the instance type,
 * preserving named types in .d.ts output:
 * - `PgModel<User>` instead of `PgModel<{ email: string; ... }>`
 *
 * @param model - Domain model from defineModel()
 * @param options - PostgreSQL-specific storage options
 * @returns PgModel with repository factory and storage metadata
 */
/**
 * Module-level set of every PgModel created in this process. Populated at
 * user-app module load (when `createPgModel` runs at file scope) before
 * any DI container exists, so this can't be a DI service.
 *
 * Read by the migration CLI at `just migrate make <name>` to auto-discover
 * schema for diff generation - no manual model list required.
 */
const registeredPgModels = new Set<PgModel<any>>();

/** Public read of all PgModels created in this process. */
export function getRegisteredPgModels(): readonly PgModel<any>[] {
  return [...registeredPgModels];
}

export function createPgModel<M extends AnyModel>(
  model: M,
  options: PgModelOptions<FieldDefs> = {},
): PgModel<InstanceType<M>> {
  const name = getModelName(model) as ModelName<InstanceType<M>>;
  const fieldDefs = getModelFields(model);

  // Register model for inject wiring (no-op if model has no inject)
  registerModelForInjection(model);

  // Register in the core model name registry (for ref serialization/deserialization)
  registerModelByName(name, model);
  // Tag the ref accessor with the model name (so References carry it)
  (model.ref as any).__modelName = name;

  // Determine table name
  const table = options.table ?? toTableName(name);

  // Determine storage mode
  const storageMode: StorageMode = options.storageMode ?? 'columnar';

  // Build column name mapping
  const columns: Record<string, string> = {};
  const jsonbFields = new Set<string>((options.jsonb ?? []) as string[]);

  for (const fieldName of Object.keys(fieldDefs)) {
    if (options.columnMap?.[fieldName]) {
      // Use explicit mapping
      columns[fieldName] = options.columnMap[fieldName] as string;
    } else if (options.preserveFieldNames) {
      // Keep original name
      columns[fieldName] = fieldName;
    } else {
      // Convert to snake_case, add _id suffix for ref fields
      const snaked = toSnakeCase(fieldName);
      const def = fieldDefs[fieldName] as { type?: string };
      columns[fieldName] = def.type === 'ref' ? `${snaked}_id` : snaked;
    }
  }

  // Build relation config map
  const relations = new Map<string, RelationConfig>();
  if (options.relations) {
    for (const [field, config] of Object.entries(options.relations)) {
      if (config) {
        relations.set(field, config);
      }
    }
  }

  // Get column metadata
  function getColumnMeta(): ColumnMeta[] {
    const result: ColumnMeta[] = [];

    for (const [fieldName, fieldDef] of Object.entries(fieldDefs)) {
      const def = fieldDef as FieldDef & {
        optional?: boolean
        unique?: boolean
      };

      // Stream fields are not stored as columns - they're pub/sub channels
      if (def.type === 'stream') continue;

      const override = options.overrides?.[fieldName];

      const meta: ColumnMeta = {
        fieldName,
        columnName: columns[fieldName],
        fieldType: def.type,
        pgType: override?.type ?? fieldTypeToPgType(def),
        nullable: override?.nullable ?? def.optional === true,
        unique: override?.unique ?? def.unique === true,
        override,
        defaultValue: (def as any).defaultValue,
      };

      // For ref/refs fields, resolve the target model name
      if ((def.type === 'ref' || def.type === 'refs') && def.refTarget) {
        try {
          const targetModel = def.refTarget();
          if (targetModel) {
            meta.refModelName = getModelName(
              targetModel as ModelClass<unknown, string>,
            );
          }
        } catch {
          // Ignore resolution errors (circular refs not yet resolved)
        }
      }

      // For enum fields, include the values
      if (def.type === 'enum' && def.enumValues) {
        meta.enumValues = def.enumValues;
      }

      result.push(meta);
    }

    return result;
  }

  // Get full storage configuration
  function getStorageConfig(): StorageConfig<FieldDefs> {
    return {
      table,
      storageMode,
      dataColumn: options.dataColumn,
      columns: getColumnMeta(),
      indexes: options.indexes ?? [],
      relations,
      jsonbFields,
    };
  }

  // Create repository factory
  function repository(client: AbstractPostgresClient): PgRepository<InstanceType<M>> {
    const repoOptions: PgRepositoryOptions = {
      tableName: table,
      storageMode,
      dataColumn: options.dataColumn,
      snakeCase: !options.preserveFieldNames,
      fieldMap: columns,
    };

    return new PgRepository<InstanceType<M>>(client, model, repoOptions);
  }

  const pgModel = {
    model,
    name,
    table,
    storageMode,
    columns,
    repository,
    getColumnMeta,
    getStorageConfig,
  } as PgModel<InstanceType<M>>;

  // Register for migrate-make auto-discovery.
  registeredPgModels.add(pgModel);

  return pgModel;
}
