import type { z } from 'zod';
import { createTrackedProxy } from './proxy.js';
import { MODEL_INTERNALS } from './symbols.js';
import type { Model, ModelInternals } from './types.js';

// Deep traverse to ensure all nested objects are proxied and parent refs registered
function deepTraverse(obj: unknown, visited = new WeakSet<object>()): void {
  if (obj === null || typeof obj !== 'object') return;
  if (visited.has(obj)) return; // Prevent infinite loops on circular refs

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

// Safe deep clone that handles proxies (skips them as they can't be cloned)
function safeDeepClone<T>(obj: T): T {
  try {
    return structuredClone(obj);
  } catch {
    // If structuredClone fails (e.g., proxies), do manual clone
    return manualDeepClone(obj);
  }
}

function manualDeepClone<T>(obj: T, visited = new WeakMap<object, unknown>()): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Handle circular refs
  if (visited.has(obj as object)) {
    return visited.get(obj as object) as T;
  }

  // For proxies, extract the underlying values
  if (Array.isArray(obj)) {
    const clone: unknown[] = [];
    visited.set(obj as object, clone);
    for (let i = 0; i < obj.length; i++) {
      clone[i] = manualDeepClone(obj[i], visited);
    }
    return clone as T;
  }

  const clone: Record<string, unknown> = {};
  visited.set(obj as object, clone);
  for (const key of Object.keys(obj)) {
    clone[key] = manualDeepClone((obj as Record<string, unknown>)[key], visited);
  }
  return clone as T;
}

/**
 * Create a model instance with schema validation and dirty tracking.
 */
export function createModelInstance<S extends z.ZodTypeAny>(
  schema: S,
  input?: z.input<S>
): Model<z.output<S>> {
  type T = z.output<S>;
  // Parse with defaults
  const parsed = schema.parse(input ?? {});
  const original = safeDeepClone(parsed);
  const dirty = new Set<string>();

  // Create the root proxy
  const proxy = createTrackedProxy(parsed as object, [], dirty) as T;

  // Traverse entire structure to ensure all proxies are created upfront
  // This registers all parent refs for shared objects
  deepTraverse(proxy);

  const internals: ModelInternals<T, S> = {
    schema,
    dirty,
    original,

    markClean() {
      dirty.clear();
    },

    isDirty() {
      return dirty.size > 0;
    },

    getDirtyPaths() {
      return [...dirty];
    },

    getDirtyData() {
      const result: Record<string, unknown> = {};

      for (const path of dirty) {
        // Get top-level keys only for signal merging
        const topKey = path.split('.')[0];
        if (topKey && !(topKey in result)) {
          result[topKey] = (proxy as Record<string, unknown>)[topKey];
        }
      }

      return result as Partial<T>;
    },
  };

  // Attach internals directly to the underlying object (not via proxy)
  Object.defineProperty(parsed, MODEL_INTERNALS, {
    value: internals,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return proxy as Model<T>;
}

/**
 * Helper to get model internals
 */
export function getModelInternals<T>(model: Model<T>): ModelInternals<T> {
  return model[MODEL_INTERNALS];
}

/**
 * Type guard to check if a value is a model
 */
export function isModel<T>(value: unknown): value is Model<T> {
  return value !== null && typeof value === 'object' && MODEL_INTERNALS in value;
}
