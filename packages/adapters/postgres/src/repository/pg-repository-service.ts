/**
 * PostgreSQL Repository Service
 *
 * Creates DI-compatible repository service definitions from PgModels.
 *
 * @example
 * ```typescript
 * import { defineModel, field } from '@justscale/core/models';
 * import { createPgModel, createPgRepository, createPostgresClient } from '@justscale/postgres';
 *
 * // Domain model
 * class User extends defineModel({
 *   email: field.string().max(255).unique(),
 *   name: field.string(),
 * }) {}
 *
 * // Storage model
 * const PgUser = createPgModel(User, { table: 'users' });
 *
 * // Repository service (for DI)
 * const UserRepository = createPgRepository(PgUser);
 *
 * // Register in cluster
 * createCluster({
 *   services: [
 *     createPostgresClient({ connectionString: '...' }),
 *     UserRepository,
 *   ],
 * });
 *
 * // Inject into services
 * const UserService = defineService({
 *   inject: { users: UserRepository },
 *   factory: ({ users }) => ({
 *     findByEmail: (email: string) =>
 *       users.findOne(User.fields.email.eq(email)),
 *   }),
 * });
 * ```
 */

import {
  REPO_BRAND,
  type ServiceDef,
  AbstractLockProvider,
  createChannels,
  defineService,
} from '@justscale/core';
import type {
  Aggregation,
  Condition,
  FindOptions,
  InsertData,
  Locked,
  ModelData,
  Ref,
  Reference,
  UpdateData,
} from '@justscale/core/models';
import { AbstractSignalBus, type SignalBus } from '@justscale/core/process';
import { AbstractPostgresClient } from '../client/client.js';
import type { PgModel } from '../model/pg-model.js';
import {
  type Persistent,
  PgRepository,
  type PgRepositoryOptions,
} from './pg-repository.js';


/**
 * Event type for model changes broadcast via channels.
 */
export interface ModelChangeEvent {
  /** Type of change */
  type: 'update' | 'delete'
  /** Table name */
  table: string
  /** Entity ID */
  id: string
}

/**
 * Shared channels service for model change notifications.
 *
 * All repositories use this to broadcast and receive entity changes.
 * Channel keys are formatted as `{tableName}:{id}`.
 *
 * @example
 * ```typescript
 * // Register in cluster
 * createClusterBuilder()
 *   .add(MemoryChannelBackend)
 *   .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
 *   .add(ModelChangeChannels)
 *   .add(UserRepository)
 *   .build()
 * ```
 */
export const ModelChangeChannels = createChannels<ModelChangeEvent>();


/**
 * Repository interface for a model.
 *
 * Parameterized by the instance type to preserve named types:
 * - `Repository<User>` instead of `Repository<{ email: string; ... }>`
 */
export interface Repository<T> {
  /** Brand to distinguish Repository from plain objects in type checking */
  readonly [REPO_BRAND]: true

  /** Find entities matching the given options */
  find(options?: FindOptions<ModelData<T>>): Promise<Persistent<T>[]>

  /** Find a single entity matching the condition */
  findOne(where: Condition): Promise<Persistent<T> | undefined>

  /** Count entities matching the condition */
  count(where?: Condition): Promise<number>

  /** Check if any entity matches the condition */
  exists(where: Condition): Promise<boolean>

  /** Run an aggregation query */
  aggregate(agg: Aggregation, where?: Condition): Promise<number | null>

  /** Insert a new entity */
  insert(data: InsertData<T>): Promise<Persistent<T>>

  /** Acquire an exclusive lock on an entity and re-read from the database */
  lock(
    entity: Ref<T> | Promise<Persistent<T> | null | undefined>,
    options?: import('@justscale/core').LockOptions,
  ): Promise<Locked<T> | null>

  /** Save (update) a persistent entity */
  save(entity: Persistent<T>): Promise<Persistent<T>>

  /** Update an entity by reference or persistent entity */
  update(
    ref: Ref<T>,
    data: UpdateData<T>,
    expectedVersion?: number,
  ): Promise<Persistent<T>>

  /** Delete an entity by reference or persistent entity */
  delete(ref: Ref<T>, expectedVersion?: number): Promise<boolean>

  /** Delete entities matching a condition */
  deleteWhere(where: Condition): Promise<number>

  /**
   * Resolve a reference to its entity.
   * This is the DDD-friendly way to fetch an entity - you work with references,
   * not raw IDs.
   *
   * @example
   * ```typescript
   * const authorRef = Author.ref`${someId}`
   * const author = await authorRepo.get(authorRef)
   * ```
   */
  get(ref: Ref<T>): Promise<Persistent<T> | undefined>

  /**
   * Get multiple entities by their references.
   * Efficiently batches into a single query.
   *
   * @example
   * ```typescript
   * const refs = [Author.ref`${id1}`, Author.ref`${id2}`]
   * const authors = await authorRepo.getMany(refs)
   * ```
   */
  getMany(refs: Ref<T>[]): Promise<Persistent<T>[]>

  /**
   * Stream entities matching the condition.
   * Yields one entity at a time for memory-efficient processing.
   *
   * Uses keyset pagination internally to avoid duplicates when data changes.
   *
   * @example
   * ```typescript
   * for await (const user of userRepo.stream({ where: User.fields.role.eq('admin') })) {
   *   await processUser(user);
   * }
   * ```
   */
  stream(
    options?: FindOptions<ModelData<T>> & { batchSize?: number },
  ): AsyncGenerator<Persistent<T>>

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
  streamBatches(
    options?: FindOptions<ModelData<T>> & { batchSize?: number },
  ): AsyncGenerator<Persistent<T>[]>

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
  observe(
    entity: Persistent<T> | Reference<T>,
  ): AsyncIterable<Persistent<T>>
}

/**
 * Service definition for a repository.
 * Can be registered in DI and injected into other services.
 *
 * Parameterized by the instance type to preserve named types.
 *
 * Note: signalBus is resolved lazily (not in inject) to avoid circular
 * dependency with SignalSubscriptionRepository.
 */
export type RepositoryServiceDef<T> = ServiceDef<
  Repository<T>,
  {
    client: typeof AbstractPostgresClient
    channels: typeof ModelChangeChannels
  }
>;


/**
 * Create a repository service definition for a PgModel.
 *
 * The returned ServiceDef is parameterized by the Model class,
 * preserving named types in .d.ts output:
 * - `RepositoryServiceDef<User>` instead of `RepositoryServiceDef<{ email: string; ... }>`
 *
 * @param pgModel - The PgModel to create a repository for
 * @returns A ServiceDef that provides Repository<T>
 *
 * @example
 * ```typescript
 * class User extends defineModel({
 *   email: field.string().unique(),
 *   name: field.string(),
 * }) {}
 *
 * const PgUser = createPgModel(User, { table: 'users' });
 * const UserRepository = createPgRepository(PgUser);
 *
 * // Register
 * createCluster({
 *   services: [PostgresClient, UserRepository],
 * });
 *
 * // Inject
 * const MyService = defineService({
 *   inject: { users: UserRepository },
 *   factory: ({ users }) => ({
 *     getUser: (ref: Reference<User>) => users.get(ref),
 *   }),
 * });
 * ```
 */
export function createPgRepository<T>(
  pgModel: PgModel<T>,
): RepositoryServiceDef<T> {
  return defineService({
    // Cast-through-unknown - Service (returned by defineService) lacks the
    // __brand that ServiceDef requires after a recent core typing change.
    // Functionally equivalent; remove once core's Service/ServiceDef
    // convergence lands.
    inject: {
      client: AbstractPostgresClient,
      channels: ModelChangeChannels,
      lockProvider: AbstractLockProvider,
    },
    factory: ({ client, channels, lockProvider }, resolve): Repository<T> => {
      // Create a lazy resolver for signalBus to avoid circular dependency.
      // SignalSubscriptionRepository is created BEFORE SignalBusService,
      // so we can't resolve AbstractSignalBus during construction.
      // Instead, we provide a getter that resolves it on first use.
      let cachedSignalBus: SignalBus | undefined | null = null; // null = not yet attempted
      const getSignalBus = async (): Promise<SignalBus | undefined> => {
        if (cachedSignalBus === null) {
          try {
            cachedSignalBus = await resolve(AbstractSignalBus);
          } catch {
            // SignalBus not available - mark as undefined so we don't retry
            cachedSignalBus = undefined;
          }
        }
        return cachedSignalBus;
      };

      const options: PgRepositoryOptions = {
        tableName: pgModel.table,
        storageMode: pgModel.storageMode,
        dataColumn: pgModel.getStorageConfig().dataColumn,
        snakeCase: true, // Use snake_case by default
        getSignalBus, // Lazy resolver for stream->process wakeup
        // Only pass fieldMap for columnar mode - JSONB uses JSON paths
        ...(pgModel.storageMode === 'columnar'
          ? { fieldMap: pgModel.columns }
          : {}),
      };

      return new PgRepository<T>(client, pgModel.model, options, channels, lockProvider);
    },
  }) as unknown as RepositoryServiceDef<T>;
}
