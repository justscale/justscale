/**
 * In-Memory Storage Model
 *
 * Wraps a domain model (from defineModel) with in-memory storage configuration.
 *
 * @example
 * ```typescript
 * import { defineModel, field } from '@justscale/core/models'
 * import { createInMemoryModel } from '@justscale/core/models/in-memory'
 *
 * class User extends defineModel({
 *   email: field.string().max(255).unique(),
 *   displayName: field.string().max(100),
 *   balance: field.decimal(10, 2).default('0.00'),
 * }) {}
 *
 * const MemoryUser = createInMemoryModel(User)
 * const userRepo = MemoryUser.repository()
 * ```
 */

import {
  type ModelClass,
  getModelFields,
  getModelName,
  registerModelForInjection,
  type AnyModel,
} from '../define-model.js';
import { registerModelByName } from '../model-name-registry.js';
import { InMemoryRepository, type InMemoryRepositoryOptions } from './in-memory-repository.js';

// ============================================================================
// Types
// ============================================================================

/** Options for creating an in-memory storage model */
export interface InMemoryModelOptions {
  /**
   * Custom ID generator function.
   * Default: crypto.randomUUID()
   */
  idGenerator?: () => string
}

/** Options for creating a repository instance */
export interface CreateRepositoryOptions {
  /**
   * Initial data to populate the repository.
   * Useful for seeding test data.
   */
  initialData?: Array<Record<string, unknown>>
}

/** In-memory storage model wrapper */
export interface InMemoryModel<T> {
  /** The underlying domain model */
  readonly model: ModelClass<T>

  /** Model name */
  readonly name: string

  /** Field definitions from the model */
  readonly fields: Record<keyof T, unknown>

  /** Create a repository for this model */
  repository(options?: CreateRepositoryOptions): InMemoryRepository<T>

  /**
   * Create a shared repository instance.
   * Multiple calls return the same repository.
   */
  sharedRepository(options?: CreateRepositoryOptions): InMemoryRepository<T>

  /**
   * Reset the shared repository.
   * Clears all data and creates a fresh instance on next access.
   */
  resetSharedRepository(): void
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an in-memory storage model from a domain model.
 *
 * @param model - Domain model from defineModel()
 * @param options - In-memory specific storage options
 * @returns InMemoryModel with repository factory
 */
export function createInMemoryModel<T>(
  model: ModelClass<T>,
  options: InMemoryModelOptions = {},
): InMemoryModel<T> {
  const name = getModelName(model);
  const fields = getModelFields(model) as Record<keyof T, unknown>;
  const idGenerator = options.idGenerator ?? (() => crypto.randomUUID());

  // Register model for inject wiring (no-op if model has no inject)
  registerModelForInjection(model as unknown as AnyModel);

  // Register in the core model name registry (for ref serialization/deserialization)
  registerModelByName(name, model as any);
  // Tag the ref accessor with the model name (so References carry it)
  (model as any).ref.__modelName = name;

  // Shared repository instance (lazily created)
  let sharedRepo: InMemoryRepository<T> | null = null;

  // Create a new repository instance
  function repository(repoOptions?: CreateRepositoryOptions): InMemoryRepository<T> {
    const opts: InMemoryRepositoryOptions = {
      idGenerator,
      initialData: repoOptions?.initialData,
      modelClass: model as unknown as { prototype: object; [key: symbol]: unknown },
    };
    return new InMemoryRepository<T>(opts);
  }

  // Get or create shared repository
  function sharedRepository(repoOptions?: CreateRepositoryOptions): InMemoryRepository<T> {
    if (!sharedRepo) {
      sharedRepo = repository(repoOptions);
    }
    return sharedRepo;
  }

  // Reset shared repository
  function resetSharedRepository(): void {
    sharedRepo = null;
  }

  return {
    model,
    name,
    fields,
    repository,
    sharedRepository,
    resetSharedRepository,
  };
}

// ============================================================================
// Repository Factory Token
// ============================================================================

/**
 * Creates a dependency injection token for an in-memory repository.
 *
 * @example
 * ```typescript
 * const User = defineModel('User', { ... })
 * const MemoryUser = createInMemoryModel(User)
 *
 * // Create DI token
 * const UserRepository = createInMemoryRepository(MemoryUser)
 *
 * // Use in service
 * const UserService = defineService({
 *   inject: { users: UserRepository },
 *   factory: ({ users }) => ({
 *     findByEmail: (email) => users.findOne(User.fields.email.eq(email)),
 *   }),
 * })
 * ```
 */
export function createInMemoryRepository<T>(
  memoryModel: InMemoryModel<T>,
  options?: CreateRepositoryOptions,
): InMemoryRepository<T> {
  return memoryModel.repository(options);
}
