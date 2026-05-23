/**
 * In-Memory Lock Provider
 *
 * A simple Map-based lock provider that works within a single process.
 * Suitable for:
 * - Single-instance applications
 * - Development and testing
 * - Applications that don't need distributed locking
 *
 * For distributed locking across multiple instances, use Redis or Postgres adapters.
 */

import { defineService } from '../../core/service.js';
import { AbstractLockProvider } from './lock-service.js';
import type { LockMetadata, LockOptions, LockProvider } from './types.js';

interface LockEntry {
  metadata: LockMetadata
  instanceId: string
  timer: ReturnType<typeof setTimeout>
}

interface Waiter {
  resolve: () => void
}

/** Return type for createInMemoryLockProvider */
export type InMemoryLockProviderInstance = LockProvider & {
  /** Clear all locks - useful for test cleanup */
  clear(): void
  /** Check if a key is locked - useful for debugging */
  isLocked(key: string): boolean
  /** Get the instance ID that holds a lock */
  getLockedBy(key: string): string | null
  /** Get the number of active locks */
  readonly size: number
};

/**
 * Create an in-memory lock provider instance.
 *
 * Use this function for testing or when you need a direct instance.
 * For DI, use `InMemoryLockProvider` service instead.
 *
 * @example
 * ```typescript
 * // Direct instantiation for testing
 * const locks = createInMemoryLockProvider()
 * await locks.acquire('key', options, instanceId)
 * locks.clear()
 * ```
 */
export function createInMemoryLockProvider(): InMemoryLockProviderInstance {
  const locks = new Map<string, LockEntry>();
  const waiters = new Map<string, Set<Waiter>>();

  function waitForRelease(key: string): Promise<void> {
    return new Promise((resolve) => {
      let waitersForKey = waiters.get(key);
      if (!waitersForKey) {
        waitersForKey = new Set();
        waiters.set(key, waitersForKey);
      }
      waitersForKey.add({ resolve });
    });
  }

  function notifyWaiters(key: string): void {
    const waitersForKey = waiters.get(key);
    if (!waitersForKey || waitersForKey.size === 0) return;

    // Convert to array and shuffle for randomness
    const waitersArray = Array.from(waitersForKey);
    shuffleArray(waitersArray);

    // Notify all (they'll race)
    for (const waiter of waitersArray) {
      waiter.resolve();
    }

    // Clear waiters
    waiters.delete(key);
  }

  function shuffleArray<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[array[i], array[j]] = [array[j], array[i]];
    }
  }

  return {
    async acquire(
      key: string,
      options: Required<LockOptions>,
      instanceId: string,
    ): Promise<LockMetadata> {
      // Keep trying until we get the lock
      while (true) {
        const existing = locks.get(key);

        // Check if lock exists and is still valid
        if (existing) {
          if (existing.metadata.expiresAt >= new Date()) {
            // Lock is held - wait for release notification
            await waitForRelease(key);
            // After being notified, loop and try again (race with other waiters)
            continue;
          }
          // Lock expired, clean it up
          clearTimeout(existing.timer);
          locks.delete(key);
          // Notify waiters that lock is available
          notifyWaiters(key);
        }

        // Try to acquire the lock (race condition possible with other waiters)
        // Use synchronous check-and-set to avoid race
        const nowCheck = locks.get(key);
        if (nowCheck && nowCheck.metadata.expiresAt >= new Date()) {
          // Someone else got it first, wait again
          continue;
        }

        // Acquire the lock
        const now = new Date();
        const metadata: LockMetadata = {
          lockedAt: now,
          expiresAt: new Date(now.getTime() + options.ttl),
          lockedBy: instanceId,
        };

        // Set up auto-expiration
        const timer = setTimeout(() => {
          const entry = locks.get(key);
          if (entry && entry.instanceId === instanceId) {
            locks.delete(key);
            // Notify waiters on expiration
            notifyWaiters(key);
          }
        }, options.ttl);

        locks.set(key, { metadata, instanceId, timer });

        return metadata;
      }
    },

    async release(key: string, instanceId: string): Promise<void> {
      const entry = locks.get(key);

      if (entry && entry.instanceId === instanceId) {
        clearTimeout(entry.timer);
        locks.delete(key);
        // Notify waiters that lock is available
        notifyWaiters(key);
      }
      // Silently ignore if lock doesn't exist or is owned by someone else
    },

    async extend(key: string, instanceId: string, ttl: number): Promise<boolean> {
      const entry = locks.get(key);

      if (!entry || entry.instanceId !== instanceId) {
        return false;
      }

      // Clear old timer
      clearTimeout(entry.timer);

      // Update expiration
      const now = new Date();
      entry.metadata = {
        ...entry.metadata,
        expiresAt: new Date(now.getTime() + ttl),
      };

      // Set new timer
      entry.timer = setTimeout(() => {
        const current = locks.get(key);
        if (current && current.instanceId === instanceId) {
          locks.delete(key);
          notifyWaiters(key);
        }
      }, ttl);

      return true;
    },

    clear(): void {
      // Get keys before clearing for notifying waiters
      const keys = Array.from(locks.keys());

      for (const entry of locks.values()) {
        clearTimeout(entry.timer);
      }
      locks.clear();

      // Notify all waiters
      for (const key of keys) {
        notifyWaiters(key);
      }
    },

    async close(): Promise<void> {
      this.clear();
    },

    isLocked(key: string): boolean {
      const entry = locks.get(key);
      return entry !== undefined && entry.metadata.expiresAt >= new Date();
    },

    getLockedBy(key: string): string | null {
      const entry = locks.get(key);
      if (entry && entry.metadata.expiresAt >= new Date()) {
        return entry.instanceId;
      }
      return null;
    },

    get size(): number {
      return locks.size;
    },
  };
}

/**
 * In-memory lock provider service for DI.
 *
 * @example
 * ```typescript
 * import { InMemoryLockProvider } from '@justscale/core';
 *
 * // For DI - auto-provides AbstractLockProvider
 * JustScale()
 *   .add(InMemoryLockProvider)
 *   .add(LockServiceDef)
 *   .build()
 *
 * // For testing - use createInMemoryLockProvider() instead
 * const locks = createInMemoryLockProvider()
 * ```
 */
export class InMemoryLockProvider extends defineService({
  inject: {},
  provides: [AbstractLockProvider],
  factory: createInMemoryLockProvider,
}) {}
