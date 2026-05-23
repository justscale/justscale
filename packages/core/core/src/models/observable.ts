import { createTrackedProxy } from './proxy.js';
import { OBSERVABLE_META } from './symbols.js';
import type { Observable, ObservableInternals } from './types.js';

// Deep traverse to ensure all nested objects are proxied
function deepTraverse(obj: unknown, visited = new WeakSet<object>()): void {
  if (obj === null || typeof obj !== 'object') return;
  if (visited.has(obj)) return;

  visited.add(obj);

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      deepTraverse(obj[i], visited);
    }
  } else {
    for (const key of Object.keys(obj)) {
      deepTraverse((obj as Record<string, unknown>)[key], visited);
    }
  }
}

/**
 * Create a standalone observable object with dirty tracking.
 * Can be used independently or passed into models.
 */
export function createObservable<T extends object>(data: T): Observable<T> {
  const dirty = new Set<string>();

  // Create the root proxy
  const proxy = createTrackedProxy(data, [], dirty) as T;

  // Traverse to ensure all nested objects are proxied upfront
  deepTraverse(proxy);

  const internals: ObservableInternals = {
    dirty,

    markClean() {
      dirty.clear();
    },

    isDirty() {
      return dirty.size > 0;
    },

    getDirtyPaths() {
      return [...dirty];
    },
  };

  // Attach internals to the underlying object
  Object.defineProperty(data, OBSERVABLE_META, {
    value: internals,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return proxy as Observable<T>;
}

/**
 * Get the internals of an observable
 */
export function getObservableInternals<T extends object>(
  observable: Observable<T>
): ObservableInternals {
  return observable[OBSERVABLE_META];
}

/**
 * Check if a value is an observable
 */
export function isObservable<T extends object>(value: unknown): value is Observable<T> {
  return value !== null && typeof value === 'object' && OBSERVABLE_META in value;
}
