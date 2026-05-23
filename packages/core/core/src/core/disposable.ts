/**
 * Disposable utilities for resource management.
 *
 * Provides helpers that return Disposable objects for use with the `using` keyword,
 * enabling cleaner cleanup code without try/finally blocks.
 *
 * @example Stack management
 * ```typescript
 * const stack: string[] = [];
 * {
 *   using _ = pushScope(stack, "request-123");
 *   // stack now contains "request-123"
 *   doWork();
 * }
 * // stack is now empty - automatically popped
 * ```
 *
 * @example Set membership
 * ```typescript
 * const activeClients = new Set<Client>();
 * {
 *   using _ = addToSet(activeClients, client);
 *   // client is now in the set
 *   await handleConnection();
 * }
 * // client automatically removed from set
 * ```
 *
 * @example Map entries
 * ```typescript
 * const cache = new Map<string, Data>();
 * {
 *   using _ = setInMap(cache, key, value);
 *   // cache[key] = value
 *   await useCache();
 * }
 * // cache entry automatically deleted
 * ```
 */

/**
 * Push a value onto a stack (array), returning a Disposable that pops it on dispose.
 *
 * @example
 * ```typescript
 * const resolutionStack: string[] = [];
 * {
 *   using _ = pushScope(resolutionStack, "ServiceA");
 *   // resolutionStack is now ["ServiceA"]
 *   resolve(dependency);
 * }
 * // resolutionStack is now [] - automatically popped
 * ```
 */
export function pushScope<T>(stack: T[], value: T): Disposable {
  stack.push(value);
  return {
    [Symbol.dispose]() {
      stack.pop();
    },
  };
}

/**
 * Add an item to a Set, returning a Disposable that removes it on dispose.
 *
 * @example
 * ```typescript
 * const clients = new Set<Client>();
 * {
 *   using _ = addToSet(clients, client);
 *   await handleMessages();
 * }
 * // client removed from set
 * ```
 */
export function addToSet<T>(set: Set<T>, value: T): Disposable {
  set.add(value);
  return {
    [Symbol.dispose]() {
      set.delete(value);
    },
  };
}

/**
 * Set a key in a Map, returning a Disposable that deletes it on dispose.
 *
 * @example
 * ```typescript
 * const pending = new Map<string, Promise<void>>();
 * {
 *   using _ = setInMap(pending, requestId, promise);
 *   await promise;
 * }
 * // requestId removed from pending
 * ```
 */
export function setInMap<K, V>(map: Map<K, V>, key: K, value: V): Disposable {
  map.set(key, value);
  return {
    [Symbol.dispose]() {
      map.delete(key);
    },
  };
}

/**
 * Create a disposable from a cleanup function.
 *
 * @example
 * ```typescript
 * {
 *   using _ = disposable(() => connection.close());
 *   await connection.query(...);
 * }
 * // connection.close() called automatically
 * ```
 */
export function disposable(cleanup: () => void): Disposable {
  return {
    [Symbol.dispose]: cleanup,
  };
}

/**
 * Create an async disposable from a cleanup function.
 *
 * @example
 * ```typescript
 * {
 *   await using _ = asyncDisposable(async () => await connection.close());
 *   await connection.query(...);
 * }
 * // await connection.close() called automatically
 * ```
 */
export function asyncDisposable(cleanup: () => Promise<void>): AsyncDisposable {
  return {
    [Symbol.asyncDispose]: cleanup,
  };
}

/**
 * Combine multiple disposables into one.
 * Disposes in reverse order (LIFO).
 *
 * @example
 * ```typescript
 * {
 *   using _ = combineDisposables(
 *     pushScope(stack, "a"),
 *     addToSet(set, item),
 *   );
 *   // both active
 * }
 * // both disposed in reverse order
 * ```
 */
export function combineDisposables(...disposables: Disposable[]): Disposable {
  return {
    [Symbol.dispose]() {
      // Dispose in reverse order. Catch any throw so subsequent disposals
      // still run — without this, one buggy dispose would leak every
      // remaining resource (HTTP server, lock connection, file handle…).
      // Surface ALL errors at the end via AggregateError so the caller
      // can see what failed instead of silent suppression.
      const errors: unknown[] = [];
      for (let i = disposables.length - 1; i >= 0; i--) {
        try {
          disposables[i][Symbol.dispose]();
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `combineDisposables: ${errors.length} disposals threw`,
        );
      }
    },
  };
}
