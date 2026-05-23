/**
 * Lock Type Definitions
 *
 * Generic lock types that can wrap any object.
 * The constraint that locks only apply to Persistent entities
 * is enforced at the usage site (e.g., in Repository).
 */

declare const LockBrand: unique symbol;

/**
 * Make all fields mutable.
 * Used by Lock<T> to allow modification of domain data.
 */
type MakeMutable<T> = {
  -readonly [K in keyof T]: T[K];
};

/**
 * Metadata attached to a locked object.
 */
export interface LockMetadata {
  readonly lockedAt: Date;
  readonly expiresAt: Date;
  readonly lockedBy: string;
}

/**
 * Marks an object as locked (exclusive access acquired).
 *
 * - Type-branded so functions can require lock proof as a parameter
 * - Implements `Disposable` (sync, fire-and-forget release) AND
 *   `AsyncDisposable` (preferred — `await using` awaits release ordering)
 * - `__active` flips to `false` after dispose. Mutators (`update`,
 *   `delete`, `save` on Repository) reject inactive locks with
 *   `LockReleasedError` to catch the use-after-dispose foot-gun.
 *
 * @example
 * ```typescript
 * // Preferred: await using — awaits the release before next code runs
 * await using user = await lockService.acquire(userRepo.get(User.ref(id)));
 *
 * // Pass to service that requires lock proof
 * await paymentService.processRefund(user);
 *
 * // Lock awaited-released when scope exits
 * ```
 *
 * @example
 * ```typescript
 * // Service requiring lock proof - prevents deadlocks from nested acquisition
 * class PaymentService {
 *   async processRefund(user: Lock<Persistent<User>>) {
 *     // Type proves caller owns the lock - no nested locking needed
 *     user.balance += refundAmount;
 *     await this.userRepo.save(user);
 *   }
 * }
 * ```
 */
export type Lock<T> = MakeMutable<T> & {
  readonly [LockBrand]: true;
  readonly __lock: LockMetadata;
  /**
   * True while the lock is held. Flips to false on `Symbol.dispose`
   * or `Symbol.asyncDispose`. Mutator APIs (`Repository.update` etc.)
   * check this and throw `LockReleasedError` if false.
   */
  readonly __active: boolean;
} & Disposable & AsyncDisposable;

/**
 * Helper to check if an object is locked at runtime.
 */
export function isLocked<T>(obj: unknown): obj is Lock<T> {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    '__lock' in obj &&
    Symbol.dispose in obj
  );
}

/**
 * Options for acquiring a lock.
 */
export interface LockOptions {
  /** Time-to-live in milliseconds. Lock auto-expires after this. Default: 30000 (30s) */
  ttl?: number;
  /** How long to wait for lock acquisition before failing. Default: 5000 (5s) */
  timeout?: number;
  /** Custom lock key. Default: derived from object */
  key?: string;
  /** Enable heartbeat to auto-extend lock. Default: false. Provider support varies. */
  heartbeat?: boolean;
  /** Heartbeat interval in ms. Default: ttl/3. Only used if heartbeat is enabled. */
  heartbeatInterval?: number;
}

/**
 * Lock storage backend interface.
 *
 * Implementations: InMemoryLockProvider, PostgresLockProvider, RedisLockProvider
 *
 * JustScale locks are ALWAYS blocking - acquire() waits forever until the lock
 * is obtained. There is no timeout, no failure. Each backend implements its own
 * efficient waiting mechanism (pub/sub, LISTEN/NOTIFY, waiter sets, etc.).
 */
export interface LockProvider {
  /**
   * Acquire a lock, blocking until acquired.
   *
   * IMPORTANT: This method blocks forever until the lock is obtained.
   * There is no timeout. Implementations must notify waiters on release.
   *
   * @returns Lock metadata once acquired
   */
  acquire(
    key: string,
    options: Required<LockOptions>,
    instanceId: string
  ): Promise<LockMetadata>;

  /**
   * Release a lock and notify any waiters.
   *
   * Safe to call even if the lock is not held or owned by another instance.
   * Must notify any waiting acquire() calls that the lock is available.
   */
  release(key: string, instanceId: string): Promise<void>;

  /**
   * Extend a lock's TTL. Used for long-running operations.
   *
   * @returns true if extended, false if lock not held or owned by another
   */
  extend(key: string, instanceId: string, ttl: number): Promise<boolean>;

  /**
   * Close the lock provider, releasing all held locks.
   * Should be called on graceful shutdown.
   */
  close(): Promise<void>;
}

/**
 * Service for acquiring distributed locks.
 *
 * Generic interface - concrete implementations may add constraints
 * (e.g., only allowing Persistent entities).
 */
export interface LockService<T = unknown> {
  /**
   * Acquire an exclusive lock on an object.
   *
   * - If passed a direct object, locks it and returns Lock<T>
   * - If passed a Promise, awaits it then locks
   * - If the object is null, returns null (no lock acquired)
   *
   * @example
   * ```typescript
   * // Direct object
   * using user = await lockService.acquire(existingUser);
   *
   * // From Promise (chain with repo call)
   * using user = await lockService.acquire(userRepo.get(User.ref(id)));
   * if (!user) throw new NotFoundError();
   * ```
   */
  acquire(
    obj: T | Promise<T> | null | Promise<T | null>,
    options?: LockOptions
  ): Promise<Lock<T> | null>;
}
