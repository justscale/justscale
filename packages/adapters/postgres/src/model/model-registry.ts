/**
 * Model Registry
 *
 * Tracks registered models and their storage configurations.
 * Used by the query compiler to resolve has() conditions across models.
 *
 * @example
 * ```typescript
 * // Models auto-register when creating repositories
 * const PgUser = createPgModel(User, { table: 'users' });
 * const userRepo = PgUser.repository(client); // Auto-registers User
 *
 * // Now Post.fields.author.has() can resolve the target table
 * const posts = await postRepo.find({
 *   where: Post.fields.author.has(User.fields.name.eq('John'))
 * });
 * ```
 */

import type { FieldDef, ModelClass } from '@justscale/core/models';
import { getModelFields, getModelName } from '@justscale/core/models';
import type { StorageMode } from '../query/query-compiler.js';


/** Stored metadata for a registered model */
export interface ModelRegistryEntry {
  /** Model name (e.g., 'User') */
  modelName: string
  /** Table name in the database */
  tableName: string
  /** Storage mode (columnar/jsonb) */
  storageMode: StorageMode
  /** Field to column name mapping */
  fieldMap: Record<string, string>
  /** Field definitions from the model */
  fieldDefs: Record<string, FieldDef>
  /** The model class itself */
  model: ModelClass<unknown>
}

/** Reference context - metadata needed for JOIN compilation */
export interface RefContext {
  /** Field name in the source model (e.g., 'author') */
  fieldName: string
  /** Column name in the source table (e.g., 'author_id') */
  fkColumn: string
  /** Target model name (e.g., 'User') */
  targetModelName: string
  /** Target table name (e.g., 'users') */
  targetTable: string
  /** Target ID column (usually 'id') */
  targetIdColumn: string
  /** Target model's field definitions */
  targetFieldDefs: Record<string, FieldDef>
  /** Target model's field map */
  targetFieldMap: Record<string, string>
  /** Target model's storage mode */
  targetStorageMode: StorageMode
}


/**
 * Global registry for model storage configurations.
 *
 * Models register themselves when repositories are created.
 * The registry is used to resolve has() conditions by looking up
 * related model's table and column information.
 */
class ModelRegistryImpl {
  private entries = new Map<string, ModelRegistryEntry>();

  /**
   * Register a model with its storage configuration.
   */
  register(entry: ModelRegistryEntry): void {
    this.entries.set(entry.modelName, entry);
  }

  /**
   * Get a model's registration entry by name.
   */
  get(modelName: string): ModelRegistryEntry | undefined {
    return this.entries.get(modelName);
  }

  /**
   * Check if a model is registered.
   */
  has(modelName: string): boolean {
    return this.entries.has(modelName);
  }

  /**
   * Clear all registrations (useful for tests).
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get all registered model names.
   */
  getRegisteredModels(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Get a model's registration entry by the model class itself.
   */
  getByModel(model: unknown): ModelRegistryEntry | undefined {
    if (!model) return undefined;

    // Try to get the model name
    try {
      const modelName = getModelName(model as ModelClass<unknown>);
      return this.get(modelName);
    } catch {
      // Model doesn't have a name, search by reference
      for (const entry of this.entries.values()) {
        if (entry.model === model) {
          return entry;
        }
      }
      return undefined;
    }
  }

  /**
   * Resolve reference context for a ref field.
   *
   * Given a source model and ref field name, returns all the metadata
   * needed to compile a has() condition (JOIN/EXISTS subquery).
   *
   * @param sourceEntry - The source model's registry entry
   * @param fieldName - The ref field name (e.g., 'author')
   * @param fieldDef - The field definition
   * @returns RefContext or undefined if target model not registered
   */
  resolveRefContext(
    sourceEntry: ModelRegistryEntry,
    fieldName: string,
    fieldDef: FieldDef,
  ): RefContext | undefined {
    // Get the target model from refTarget
    if (!fieldDef.refTarget) {
      return undefined;
    }

    let targetModel: ModelClass<unknown>;
    try {
      targetModel = fieldDef.refTarget() as ModelClass<unknown>;
    } catch {
      // Circular reference not yet resolved
      return undefined;
    }

    if (!targetModel) {
      return undefined;
    }

    // Get target model name and look up in registry
    const targetModelName = getModelName(targetModel);
    const targetEntry = this.get(targetModelName);

    if (!targetEntry) {
      return undefined;
    }

    // Determine FK column name in source table
    // Convention: field 'author' -> column 'author_id'
    const fkColumn =
      sourceEntry.fieldMap[fieldName] ?? this.toSnakeCase(fieldName);

    return {
      fieldName,
      fkColumn,
      targetModelName,
      targetTable: targetEntry.tableName,
      targetIdColumn: 'id', // Convention: PK is always 'id'
      targetFieldDefs: targetEntry.fieldDefs,
      targetFieldMap: targetEntry.fieldMap,
      targetStorageMode: targetEntry.storageMode,
    };
  }

  private toSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }
}

/** Global model registry instance */
export const ModelRegistry = new ModelRegistryImpl();

/**
 * Helper to register a model with the global registry.
 *
 * @example
 * ```typescript
 * registerModel({
 *   model: User,
 *   tableName: 'users',
 *   storageMode: 'columnar',
 *   fieldMap: { email: 'email', displayName: 'display_name' },
 * });
 * ```
 */
export function registerModel(
  model: ModelClass<unknown>,
  config: {
    tableName: string
    storageMode: StorageMode
    fieldMap: Record<string, string>
  },
): void {
  const modelName = getModelName(model);
  const fieldDefs = getModelFields(model);

  ModelRegistry.register({
    modelName,
    model,
    tableName: config.tableName,
    storageMode: config.storageMode,
    fieldMap: config.fieldMap,
    fieldDefs,
  });
}
