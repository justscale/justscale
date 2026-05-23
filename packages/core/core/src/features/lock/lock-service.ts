/**
 * Distributed lock service with pluggable backend (Redis, Postgres, in-memory, etc.)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { defineAbstract, defineService, Logger } from '../../core/index.js';
import type {
  Lock,
  LockMetadata,
  LockOptions,
  LockProvider,
  LockService,
} from './types.js';

const DEFAULT_TTL = 30_000;
const DEFAULT_TIMEOUT = 5_000;

export abstract class AbstractLockProvider extends defineAbstract<LockProvider>('AbstractLockProvider') {}

function generateInstanceId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function deriveLockKey(obj: unknown): string {
  const typeName =
    (obj as { constructor?: { name?: string } })?.constructor?.name ?? 'Object';
  const id = (obj as { id?: unknown })?.id ?? 'unknown';
  return `lock:${typeName}:${String(id)}`;
}

const heldLocks = new AsyncLocalStorage<Set<string>>();

/**
 * Run a function with lock tracking enabled.
 * Any locks acquired inside will be tracked and checked for double-lock.
 */
export function runWithLockTracking<T>(fn: () => T): T {
  return heldLocks.run(new Set(), fn);
}

/**
 * Get the set of currently held lock keys in this async context.
 * Returns undefined if lock tracking is not active.
 */
export function getHeldLocks(): ReadonlySet<string> | undefined {
  return heldLocks.getStore();
}

/**
 * Internal: register that a lock key was acquired in this async context.
 * Used by Repository.lock() implementations to participate in
 * `runWithLockTracking` re-entry detection. No-op outside a tracking
 * context. Not part of the public API.
 *
 * @internal
 */
export function _registerHeldLock(key: string): void {
  heldLocks.getStore()?.add(key);
}

/**
 * Internal: clear a held-lock entry on release. Mirror of
 * `_registerHeldLock`. No-op outside a tracking context.
 *
 * @internal
 */
export function _unregisterHeldLock(key: string): void {
  heldLocks.getStore()?.delete(key);
}

class LockServiceImpl<T> implements LockService<T> {
  private readonly instanceId = generateInstanceId();

  constructor(
    private readonly provider: LockProvider,
    private readonly logger: Logger
  ) {}

  async acquire(
    objOrPromise: T | Promise<T> | null | Promise<T | null>,
    options?: LockOptions
  ): Promise<Lock<T> | null> {
    // Await if promise
    const obj = await objOrPromise;

    // Handle null case
    if (obj === null) {
      return null;
    }

    const ttl = options?.ttl ?? DEFAULT_TTL;
    const opts: Required<LockOptions> = {
      ttl,
      timeout: options?.timeout ?? DEFAULT_TIMEOUT,
      key: options?.key ?? deriveLockKey(obj),
      heartbeat: options?.heartbeat ?? false,
      heartbeatInterval: options?.heartbeatInterval ?? Math.floor(ttl / 3),
    };

    if (opts.key.trim() === '') {
      throw new InvalidLockKeyError(opts.key);
    }

    // Double-lock detection: throw if this key is already held in this async context
    const held = heldLocks.getStore();
    if (held?.has(opts.key)) {
      throw new DoubleLockError(opts.key);
    }

    const metadata = await this.provider.acquire(opts.key, opts, this.instanceId);

    // Track the held lock
    held?.add(opts.key);

    this.logger.debug('Lock acquired', {
      key: opts.key,
      instanceId: this.instanceId,
      ttl: opts.ttl,
    });

    return this.createLockedObject(obj, metadata, opts.key);
  }

  private createLockedObject(
    obj: T,
    metadata: LockMetadata,
    key: string
  ): Lock<T> {
    const provider = this.provider;
    const instanceId = this.instanceId;
    const logger = this.logger;

    let active = true;
    const locked = Object.create(obj as object, {
      __lock: {
        value: metadata,
        writable: false,
        enumerable: false,
        configurable: false,
      },
      __active: {
        get: () => active,
        enumerable: false,
        configurable: false,
      },
      [Symbol.dispose]: {
        value: function (this: Lock<T>) {
          if (!active) return;
          active = false;
          heldLocks.getStore()?.delete(key);

          provider.release(key, instanceId).catch((err: unknown) => {
            logger.warn('Lock release failed, will expire via TTL', {
              key,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        writable: false,
        enumerable: false,
        configurable: false,
      },
      [Symbol.asyncDispose]: {
        value: async function (this: Lock<T>) {
          if (!active) return;
          active = false;
          heldLocks.getStore()?.delete(key);
          try {
            await provider.release(key, instanceId);
          } catch (err) {
            logger.warn('Lock release failed, will expire via TTL', {
              key,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        writable: false,
        enumerable: false,
        configurable: false,
      },
    });

    return locked as Lock<T>;
  }
}

export class LockAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockAcquisitionError';
  }
}

/**
 * Thrown when code tries to acquire a lock already held in the same async context.
 */
export class DoubleLockError extends Error {
  readonly lockKey: string;
  constructor(key: string) {
    super(`Cannot acquire lock "${key}" - already held in this async context. Release the existing lock before acquiring a new one.`);
    this.name = 'DoubleLockError';
    this.lockKey = key;
  }
}

/**
 * Thrown when a mutator (`Repository.update`, `delete`, `save`) is called
 * with a `Lock<T>` whose `__active` is false — i.e. the lock has already
 * been released via `Symbol.dispose` / `Symbol.asyncDispose`.
 *
 * This is the use-after-dispose guard: storing a `Locked<T>` in an outer
 * scope and using it after the `using` block exits is a footgun the
 * type system doesn't catch (the `__active` field can't be narrowed
 * statically), so it surfaces at runtime here.
 */
export class LockReleasedError extends Error {
  readonly lockKey: string | undefined;
  constructor(key?: string) {
    super(
      key
        ? `Lock "${key}" was used after release. Acquire a fresh lock before mutating.`
        : 'Lock was used after release. Acquire a fresh lock before mutating.',
    );
    this.name = 'LockReleasedError';
    this.lockKey = key;
  }
}

/**
 * Thrown when a lock key is empty or whitespace-only. Empty keys would
 * collide every locked resource into one global bucket, so they are
 * rejected at the API boundary.
 */
export class InvalidLockKeyError extends Error {
  constructor(key: string) {
    super(
      `Lock key must be a non-empty string; received ${JSON.stringify(key)}. ` +
      'Empty keys would collide every locked resource into one bucket. ' +
      'Omit \'key\' to derive it from the locked object, or pass a meaningful identifier.'
    );
    this.name = 'InvalidLockKeyError';
  }
}

export class LockServiceDef extends defineService({
  inject: {
    provider: AbstractLockProvider,
    logger: Logger,
  },
  factory: ({ provider, logger }): LockService<unknown> =>
    new LockServiceImpl(provider, logger),
}) {}
