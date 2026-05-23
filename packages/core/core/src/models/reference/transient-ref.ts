/**
 * TransientRef - A reference to an unsaved (transient) entity.
 *
 * Unlike Reference<T> which holds an ID, TransientRef holds the actual
 * entity instance. When the entity is saved, TransientRef can be
 * converted to a regular Reference.
 *
 * Used for building entity graphs before persistence.
 *
 * @example
 * ```typescript
 * const User = defineModel('User', {
 *   name: field.string(),
 * });
 *
 * const Post = defineModel('Post', {
 *   title: field.string(),
 *   author: field.ref(User),
 * });
 *
 * // Create an unsaved user
 * const user = new User({ name: 'Alice' });
 *
 * // Reference it before saving
 * const post = new Post({
 *   title: 'My Post',
 *   author: new TransientRef(user),
 * });
 *
 * // Later, after saving the user, convert to regular Reference
 * await userRepo.save(user);
 * const authorRef = post.author.toReference(); // Now has ID
 * ```
 */

import type { Persistent } from '../types.js';
import { TRANSIENT_REF, TRANSIENT_TARGET, ADAPTER_KEY, PERSISTENT } from '../symbols.js';
import { Reference } from './reference.js';

/**
 * A reference to an unsaved (transient) entity that implements PromiseLike.
 *
 * The transient reference holds:
 * - The entity instance (always available synchronously)
 * - No ID (until the entity is saved)
 *
 * TransientRef implements PromiseLike, so you can await it to get the entity:
 *   const author = await post.author; // Works for both Reference and TransientRef
 *
 * @example
 * ```typescript
 * const User = defineModel('User', {
 *   name: field.string(),
 * });
 *
 * const user = new User({ name: 'Alice' });
 * const ref = new TransientRef(user);
 *
 * // Await to get the entity
 * const entity = await ref;
 *
 * // Or access synchronously
 * ref.target;    // User instance
 * ref.isLoaded;  // Always true for TransientRef
 *
 * // After saving, convert to Reference
 * await userRepo.save(user);
 * const persistentRef = ref.toReference(); // Reference<User>
 * ```
 */
export class TransientRef<T> implements PromiseLike<T | Persistent<T>> {
  /** Symbol marker for type identification */
  readonly [TRANSIENT_REF] = true as const;

  /** Internal target entity storage */
  private readonly [TRANSIENT_TARGET]: T | Persistent<T>;

  constructor(target: T | Persistent<T>) {
    this[TRANSIENT_TARGET] = target;
  }

  /** The referenced entity - always available synchronously */
  get target(): T | Persistent<T> {
    return this[TRANSIENT_TARGET];
  }

  /** Whether the reference is loaded - always true for TransientRef */
  get isLoaded(): boolean {
    return true;
  }

  /** The resolved entity - same as target for TransientRef */
  get value(): T | Persistent<T> {
    return this[TRANSIENT_TARGET];
  }

  /** The resolved entity or null - never null for TransientRef */
  get valueOrNull(): T | Persistent<T> {
    return this[TRANSIENT_TARGET];
  }

  /**
   * Implement PromiseLike - makes the transient reference directly awaitable.
   *
   * `await post.author` works whether author is a Reference or TransientRef.
   *
   * For TransientRef, this resolves immediately (synchronously) to the target entity.
   */
  then<TResult1 = T | Persistent<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: T | Persistent<T>) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    // Always resolve immediately with the target entity
    return Promise.resolve(this[TRANSIENT_TARGET]).then(onfulfilled, onrejected);
  }

  /**
   * Convert this transient reference to a regular Reference.
   *
   * This requires the entity to have been persisted (must have an id).
   * Throws if the entity doesn't have an ID yet.
   *
   * @throws Error if the entity doesn't have an id
   *
   * @example
   * ```typescript
   * const user = new User({ name: 'Alice' });
   * const ref = new TransientRef(user);
   *
   * await userRepo.save(user); // Now user has an id
   * const persistentRef = ref.toReference(); // Reference<User>
   * ```
   */
  toReference(): Reference<T> {
    const entity = this[TRANSIENT_TARGET] as Record<string | symbol, unknown>;
    const key = entity[ADAPTER_KEY] as string | undefined;

    if (!key) {
      throw new Error(
        'Cannot convert TransientRef to Reference: entity has no adapter key. Save the entity first.',
      );
    }

    return Reference.resolved(key, entity as Persistent<T>) as Reference<T>;
  }

  /**
   * Check if this transient reference can be converted to a Reference.
   * Returns true if the entity has been persisted (has an adapter key).
   */
  canConvert(): boolean {
    const entity = this[TRANSIENT_TARGET] as Record<string | symbol, unknown>;
    return !!(entity[ADAPTER_KEY] ?? entity[PERSISTENT]);
  }

  /**
   * Create a transient reference to an entity.
   */
  static create<T>(target: T | Persistent<T>): TransientRef<T> {
    return new TransientRef<T>(target);
  }
}

/**
 * Type guard to check if a value is a TransientRef.
 */
export function isTransientRef<T>(value: unknown): value is TransientRef<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    TRANSIENT_REF in value &&
    (value as Record<symbol, unknown>)[TRANSIENT_REF] === true
  );
}
