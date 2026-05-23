/**
 * ModelRepository - Abstract Repository with Token System
 *
 * Base class for data access that works with the query system.
 * Implementations (Postgres, SQLite, Memory) extend this.
 *
 * Key features:
 * - ModelRepository<T> is the abstract contract for CRUD operations
 * - ModelRepository.of(Model) creates a DI token for injection
 *
 * @example
 * ```typescript
 * // Get a token for dependency injection
 * const userRepoToken = ModelRepository.of(User);
 *
 * // Domain service depends on the token
 * const UserService = defineService({
 *   inject: { users: ModelRepository.of(User) },
 *   factory: ({ users }) => ({
 *     async findByEmail(email: string) {
 *       return users.findOne(User.fields.email.eq(email));
 *     },
 *   }),
 * });
 * ```
 */

import type { Condition, FindOptions, Aggregation, OrderBy } from './query.js';
import type { Persistent, Locked, Ref, Transient, SystemFields, InsertData, UpdateData } from './types.js';
import type { LockOptions } from '../features/lock/types.js';
import type { DurableQueryIterable } from '../process/primitives.js';
import { BaseModel, MODEL_STABLE_ID, type Model, type RepositoryContract } from './define-model.js';
import { Repository, REPO_TOKEN } from './repository.js';
import type { RepositoryToken } from './repository.js';
import { MODEL_REPO_MODEL, MODEL_REPO_CONTRACT } from './symbols.js';

// Any class that extends BaseModel
// biome-ignore lint/suspicious/noExplicitAny: Need any for variance
type AnyModel = abstract new (...args: any[]) => BaseModel<any, any, any>;

// Re-export for convenience
export { MODEL_REPO_MODEL, MODEL_REPO_CONTRACT };

// ============================================================================
// Token Types
// ============================================================================

/**
 * Extract repository contract from a model class.
 */
// biome-ignore lint/suspicious/noExplicitAny: Using any to avoid variance issues
export type ExtractContract<M> = M extends Model<any, any, infer C>
  ? C extends RepositoryContract<any>
    ? C
    : {}
  : {};

/**
 * Extract the instance type from a model class.
 * Since models are proper classes, we can use InstanceType directly.
 */
// biome-ignore lint/suspicious/noExplicitAny: Need any for variance
export type ModelInstanceType<M> = M extends abstract new (...args: any[]) => infer T ? T : never;

/**
 * A ModelRepository token for dependency injection.
 *
 * Extends the generic RepositoryToken from core with model-specific metadata.
 * Created via ModelRepository.of(Model).
 *
 * If the model has a repository contract (via .withRepository()), the token
 * type includes those methods in addition to the base ModelRepository methods.
 */
export interface ModelRepositoryToken<T, C extends RepositoryContract<T> = {}> extends RepositoryToken<T, ModelRepository<T> & C> {
  /** The model this token is for */
  readonly [MODEL_REPO_MODEL]: Model<T>;
  /** The contract type (type-level only) */
  readonly [MODEL_REPO_CONTRACT]?: C;
}

// ============================================================================
// Abstract Repository
// ============================================================================

// SystemFields and input types are imported from types.ts
export type { SystemFields, InsertData, UpdateData };

/**
 * Abstract repository for model data access.
 *
 * Extends the generic Repository from core with model-specific operations
 * like find, get, insert, update, delete, and query support.
 *
 * Implementations can be created for PostgreSQL, SQLite, in-memory, etc.
 *
 * @typeParam T - The entity type this repository manages
 */
export abstract class ModelRepository<T> extends Repository<T> {
  // ─────────────────────────────────────────────────────────────────────────
  // Query Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Find all entities matching the given options.
   *
   * @example
   * ```typescript
   * // Find all active users, ordered by creation date
   * const users = await userRepo.find({
   *   where: User.fields.status.eq('active'),
   *   orderBy: [User.fields.createdAt.desc()],
   *   limit: 10,
   * });
   * ```
   */
  abstract find(options?: FindOptions<T>): Promise<Persistent<T>[]>;

  /**
   * Get an entity by its reference.
   * This is the type-safe way to look up entities - you can't accidentally
   * pass a User reference to a PostRepository.
   *
   * @example
   * ```typescript
   * const user = await users.get(User.ref`${userId}`)  // Type-safe!
   * ```
   */
  abstract get(ref: Ref<T>): Promise<Persistent<T> | undefined>;

  /**
   * Get multiple entities by their references.
   * Batches into a single query where possible.
   *
   * @example
   * ```typescript
   * const users = await users.getMany([User.ref`1`, User.ref`2`])
   * ```
   */
  abstract getMany(refs: Ref<T>[]): Promise<Persistent<T>[]>;

  /**
   * Find a single entity matching the condition.
   * Returns undefined if not found.
   *
   * @example
   * ```typescript
   * const user = await userRepo.findOne(User.fields.email.eq('alice@example.com'));
   * ```
   */
  abstract findOne(where: Condition): Promise<Persistent<T> | undefined>;

  /**
   * Count entities matching the given condition.
   */
  abstract count(where?: Condition): Promise<number>;

  /**
   * Check if any entity matches the condition.
   */
  async exists(where: Condition): Promise<boolean> {
    const count = await this.count(where);
    return count > 0;
  }

  /**
   * Run an aggregation query (sum, avg, min, max, count).
   *
   * @example
   * ```typescript
   * const totalViews = await postRepo.aggregate(
   *   q.sum('views'),
   *   Post.fields.published.eq(true),
   * );
   * ```
   */
  abstract aggregate(agg: Aggregation, where?: Condition): Promise<number | null>;

  // ─────────────────────────────────────────────────────────────────────────
  // Mutation Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Insert a new entity.
   *
   * @example
   * ```typescript
   * const user = await userRepo.insert({
   *   email: 'alice@example.com',
   *   name: 'Alice',
   * });
   * // user is Persistent<User> with id, createdAt, etc.
   * ```
   */
  abstract insert(data: InsertData<T>): Promise<Persistent<T>>;

  /**
   * Insert multiple entities.
   */
  abstract insertMany(data: InsertData<T>[]): Promise<Persistent<T>[]>;

  /**
   * Acquire an exclusive lock on an entity and re-read it from storage.
   *
   * Concurrent acquirers (in this process or across cluster instances
   * when wired with PostgresLockProvider/RedisLockProvider) BLOCK until
   * the holder releases. The lock is released on `Symbol.asyncDispose`
   * (preferred — `await using`) or sync `Symbol.dispose` (fire-and-forget).
   *
   * Re-reads under the lock so callers see committed state. Returns null
   * if the row was deleted before/during the acquire.
   *
   * Mutators (`update`, `delete`, `save(Locked<T>)`) require the
   * `__active` flag to still be true; using a `Locked<T>` after its
   * `using` block exited throws `LockReleasedError`.
   *
   * Same async context re-acquiring the same row throws
   * `DoubleLockError` (when wrapped in `runWithLockTracking`) — this
   * would deadlock otherwise.
   *
   * @returns Locked entity, or null if not found
   *
   * @example
   * ```typescript
   * await using user = await users.lock(params.user);
   * if (!user) return res.status(404).json({ error: 'Not found' });
   * await service.updateProfile(user, data);
   * // mutex released, lock invalidated when scope exits
   * ```
   */
  abstract lock(
    entity: Ref<T> | Promise<Persistent<T> | null | undefined>,
    options?: LockOptions,
  ): Promise<Locked<T> | null>;

  /**
   * Update a locked entity with partial data.
   *
   * Requires a lock - the lock IS your concurrency control.
   */
  abstract update(entity: Locked<T>, data: UpdateData<T>): Promise<Persistent<T>>;

  /**
   * Save an entity (insert or update).
   *
   * - New entity (`T` / `Transient<T>`) → insert
   * - Locked entity (`Locked<T>`) → update
   */
  abstract save(entity: T | Transient<T>): Promise<Persistent<T>>;
  abstract save(entity: Locked<T>): Promise<Persistent<T>>;
  abstract save(entity: T | Transient<T> | Locked<T>): Promise<Persistent<T>>;

  /**
   * Delete a locked entity.
   *
   * Requires a lock to ensure no concurrent mutations during deletion.
   *
   * @returns true if deleted, false if not found
   */
  abstract delete(entity: Locked<T>): Promise<boolean>;

  /**
   * Delete entities matching a condition.
   *
   * @returns Number of deleted entities
   */
  abstract deleteWhere(where: Condition): Promise<number>;

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming / Pagination
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a durable iterator for use in process for-of loops.
   * Uses keyset pagination to support suspend/resume across process restarts.
   *
   * `orderBy` is required - durable iteration needs deterministic ordering
   * for keyset pagination to work correctly.
   *
   * @example
   * ```typescript
   * for (const order of orders.iterate({
   *   where: Order.fields.status.eq('pending'),
   *   orderBy: { createdAt: 'asc' },
   * })) {
   *   await signal(fulfillment.shipped)
   * }
   * ```
   */
  abstract iterate(options: FindOptions<T> & { orderBy: OrderBy<T> }): DurableQueryIterable<Persistent<T>>;

  /**
   * Stream entities matching the condition.
   * Yields one entity at a time for memory-efficient processing.
   *
   * @example
   * ```typescript
   * for await (const user of userRepo.stream({ where: status.eq('active') })) {
   *   await processUser(user);
   * }
   * ```
   */
  abstract stream(options?: FindOptions<T>): AsyncIterable<Persistent<T>>;

  /**
   * Stream entities in batches.
   * More efficient than streaming one at a time for bulk operations.
   *
   * @example
   * ```typescript
   * for await (const batch of userRepo.streamBatches({ batchSize: 100 })) {
   *   await processBatch(batch);
   * }
   * ```
   */
  abstract streamBatches(options?: FindOptions<T> & { batchSize?: number }): AsyncIterable<Persistent<T>[]>;

  // ─────────────────────────────────────────────────────────────────────────
  // Live Model Observation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Observe changes to an entity.
   *
   * Returns an async iterable that yields whenever the entity is updated
   * from any instance (including other nodes in the cluster).
   *
   * The entity object is mutated in-place via the identity map, so you
   * can also just access the original reference after yielding.
   *
   * @example
   * ```typescript
   * const user = await userRepo.get(User.ref`123`);
   *
   * // Observe changes from anywhere
   * for await (const _ of userRepo.observe(user)) {
   *   console.log('User updated:', user.name); // same object, mutated
   * }
   *
   * // Also works with references
   * for await (const author of userRepo.observe(post.author)) {
   *   console.log('Author updated:', author.name);
   * }
   * ```
   */
  abstract observe(entity: Ref<T>): AsyncIterable<Persistent<T>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Static Token Factory
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a DI token for a model's repository.
   *
   * Tokens are memoized - same model always returns same token object.
   * This enables object identity comparison for DI container lookups.
   *
   * If the model has a repository contract (via .withRepository()), the token
   * type includes those custom methods.
   *
   * @example
   * ```typescript
   * const token = ModelRepository.of(User);
   *
   * // Same model = same token (object identity)
   * ModelRepository.of(User) === ModelRepository.of(User)  // true
   *
   * // Different models = different tokens
   * ModelRepository.of(User) === ModelRepository.of(Post)  // false
   *
   * // With custom contract
   * const UserWithRepo = User.withRepository<{
   *   findByEmail(email: string): Promise<User | null>;
   * }>();
   * const token = ModelRepository.of(UserWithRepo);
   * // token type includes findByEmail method
   * ```
   */
  // biome-ignore lint/suspicious/noExplicitAny: Using any to avoid variance issues
  static of<M extends AnyModel>(
    model: M
  ): ModelRepositoryToken<ModelInstanceType<M>, ExtractContract<M>> {
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic token creation
    return getOrCreateToken(model) as any;
  }
}

// ============================================================================
// Token Registry (WeakMap for memoization)
// ============================================================================

// biome-ignore lint/suspicious/noExplicitAny: Internal registry uses any
const tokenRegistry = new WeakMap<AnyModel, ModelRepositoryToken<any>>();

// Secondary index by stable ID - two classes with the same stable ID (e.g. after HMR)
// resolve to the same token without any special-casing.
// biome-ignore lint/suspicious/noExplicitAny: dynamic token type
const tokenRegistryByStableId = new Map<string, ModelRepositoryToken<any>>();

function getOrCreateToken<T>(model: AnyModel): ModelRepositoryToken<T> {
  const stableId = (model as unknown as Record<symbol, unknown>)[MODEL_STABLE_ID] as string | undefined;

  if (stableId) {
    const cached = tokenRegistryByStableId.get(stableId);
    if (cached) {
      // Fresh class ref with same stable ID - update token's model
      // slot so reads see the current class's fields / metadata.
      if ((cached as unknown as Record<symbol, unknown>)[MODEL_REPO_MODEL] !== model) {
        Object.defineProperty(cached, MODEL_REPO_MODEL, {
          value: model,
          enumerable: false,
          writable: true,
          configurable: true,
        });
      }
      return cached as ModelRepositoryToken<T>;
    }
  }

  let token = tokenRegistry.get(model);

  if (!token) {
    const description = `ModelRepository<${model.name}>`;

    // biome-ignore lint/suspicious/noExplicitAny: Token creation is dynamic
    token = Object.create(null) as ModelRepositoryToken<any>;
    Object.defineProperties(token, {
      [REPO_TOKEN]: { value: true, enumerable: false },
      [MODEL_REPO_MODEL]: { value: model, enumerable: false, writable: true, configurable: true },
      description: { value: description, enumerable: true },
      toString: { value: () => description, enumerable: false },
    });

    // Intentionally NOT frozen: `MODEL_REPO_MODEL` must stay writable
    // so a fresh class ref with the same stable ID can swap its
    // internal model target without losing token identity.

    tokenRegistry.set(model, token);
    if (stableId) tokenRegistryByStableId.set(stableId, token);
  } else if (stableId && !tokenRegistryByStableId.has(stableId)) {
    tokenRegistryByStableId.set(stableId, token);
  }

  return token as ModelRepositoryToken<T>;
}

/**
 * Check if a value is a ModelRepository token.
 */
export function isModelRepositoryToken(value: unknown): value is ModelRepositoryToken<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    REPO_TOKEN in value &&
    (value as any)[REPO_TOKEN] === true &&
    MODEL_REPO_MODEL in value
  );
}
