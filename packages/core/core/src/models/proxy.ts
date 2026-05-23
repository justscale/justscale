import { MODEL_INTERNALS, OBSERVABLE_META } from './symbols.js';
import type { ProxyMeta } from './types.js';
import { notifyWatchers } from './watch.js';

// Built-in objects with internal slots that break when methods are called with proxy as `this`
// These require binding to the original target, not the proxy
const BUILTIN_WITH_INTERNAL_SLOTS = new Set([
  Map,
  Set,
  WeakMap,
  WeakSet,
  Date,
  ArrayBuffer,
  SharedArrayBuffer,
  DataView,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  RegExp,
  Promise,
]);

function hasInternalSlots(obj: object): boolean {
  for (const BuiltIn of BUILTIN_WITH_INTERNAL_SLOTS) {
    if (obj instanceof BuiltIn) return true;
  }
  return false;
}

// Methods that mutate built-in objects - we need to track these
const MAP_MUTATORS = new Set(['set', 'delete', 'clear']);
const WEAKMAP_MUTATORS = new Set(['set', 'delete']);
const SET_MUTATORS = new Set(['add', 'delete', 'clear']);
const WEAKSET_MUTATORS = new Set(['add', 'delete']);
const DATE_MUTATORS = new Set([
  'setDate',
  'setFullYear',
  'setHours',
  'setMilliseconds',
  'setMinutes',
  'setMonth',
  'setSeconds',
  'setTime',
  'setUTCDate',
  'setUTCFullYear',
  'setUTCHours',
  'setUTCMilliseconds',
  'setUTCMinutes',
  'setUTCMonth',
  'setUTCSeconds',
  'setYear',
]);
const TYPED_ARRAY_MUTATORS = new Set(['fill', 'set', 'copyWithin', 'sort', 'reverse']);
const DATAVIEW_MUTATORS = new Set([
  'setInt8',
  'setUint8',
  'setInt16',
  'setUint16',
  'setInt32',
  'setUint32',
  'setFloat32',
  'setFloat64',
  'setBigInt64',
  'setBigUint64',
]);

function isTypedArray(obj: object): boolean {
  return (
    obj instanceof Int8Array ||
    obj instanceof Uint8Array ||
    obj instanceof Uint8ClampedArray ||
    obj instanceof Int16Array ||
    obj instanceof Uint16Array ||
    obj instanceof Int32Array ||
    obj instanceof Uint32Array ||
    obj instanceof Float32Array ||
    obj instanceof Float64Array ||
    obj instanceof BigInt64Array ||
    obj instanceof BigUint64Array
  );
}

function isMutatingMethod(obj: object, prop: string | symbol): boolean {
  if (typeof prop !== 'string') return false;
  if (obj instanceof Map) return MAP_MUTATORS.has(prop);
  if (obj instanceof WeakMap) return WEAKMAP_MUTATORS.has(prop);
  if (obj instanceof Set) return SET_MUTATORS.has(prop);
  if (obj instanceof WeakSet) return WEAKSET_MUTATORS.has(prop);
  if (obj instanceof Date) return DATE_MUTATORS.has(prop);
  if (obj instanceof DataView) return DATAVIEW_MUTATORS.has(prop);
  if (isTypedArray(obj)) return TYPED_ARRAY_MUTATORS.has(prop);
  return false;
}

// Symbol for proxy metadata
const PROXY_META = Symbol('proxy_meta');

// Node.js inspection symbol
const NODE_INSPECT = Symbol.for('nodejs.util.inspect.custom');

// Well-known symbols that should pass through directly to target
// These are used for introspection, iteration, type coercion, etc.
const PASSTHROUGH_SYMBOLS = new Set<symbol>([
  Symbol.toStringTag,
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.toPrimitive,
  Symbol.hasInstance,
  Symbol.isConcatSpreadable,
  Symbol.species,
  Symbol.unscopables,
  Symbol.match,
  Symbol.matchAll,
  Symbol.replace,
  Symbol.search,
  Symbol.split,
  Symbol.dispose,
  Symbol.asyncDispose,
  NODE_INSPECT,
]);

// WeakMap to track original object -> proxy mapping (handles circular refs)
const proxyCache = new WeakMap<object, object>();
const metaCache = new WeakMap<object, ProxyMeta>();

// Map root proxies to their dirty sets
const rootDirtySetMap = new WeakMap<ProxyMeta, Set<string>>();

interface PathWithDirtySet {
  path: string[];
  dirtySet: Set<string>;
}

// Mark a container (like Map/Set/Date) and its parent paths as dirty
// Unlike markDirtyWithParents, this doesn't add a sub-key
function markContainerDirty(meta: ProxyMeta): void {
  const pathsWithDirtySets = collectPathsWithDirtySets(meta);
  const modifiedDirtySets = new Set<Set<string>>();

  for (const { path, dirtySet } of pathsWithDirtySets) {
    // Add the full path to this container
    if (path.length > 0) {
      dirtySet.add(path.join('.'));
      modifiedDirtySets.add(dirtySet);
    }
    // Add parent paths
    for (let i = path.length - 1; i > 0; i--) {
      dirtySet.add(path.slice(0, i).join('.'));
    }
  }

  for (const dirtySet of modifiedDirtySets) {
    notifyWatchers(dirtySet);
  }
}

function markDirtyWithParents(meta: ProxyMeta, key: string | symbol): void {
  // Collect all paths paired with their root's dirty set
  const pathsWithDirtySets = collectPathsWithDirtySets(meta);

  // Track which dirty sets were modified for notification
  const modifiedDirtySets = new Set<Set<string>>();

  // Mark dirty only in the correct dirty set for each path
  for (const { path: basePath, dirtySet } of pathsWithDirtySets) {
    const fullPath = [...basePath, String(key)].join('.');
    dirtySet.add(fullPath);
    modifiedDirtySets.add(dirtySet);

    // Also mark parent paths dirty
    for (let i = basePath.length; i > 0; i--) {
      dirtySet.add(basePath.slice(0, i).join('.'));
    }
  }

  // Notify watchers for each modified dirty set
  for (const dirtySet of modifiedDirtySets) {
    notifyWatchers(dirtySet);
  }
}

function collectPathsWithDirtySets(meta: ProxyMeta): PathWithDirtySet[] {
  const results: PathWithDirtySet[] = [];
  // Use path string to dedupe (same path + same dirtySet = skip)
  const seenPathDirtySet = new Map<Set<string>, Set<string>>();

  function traverse(current: ProxyMeta, pathSuffix: string[], pathStack: ProxyMeta[]): void {
    // If this proxy was originally a root (observable/model), include its dirty set
    const ownDirtySet = rootDirtySetMap.get(current);
    if (ownDirtySet) {
      const pathStr = pathSuffix.join('.');
      let seenPaths = seenPathDirtySet.get(ownDirtySet);
      if (!seenPaths) {
        seenPaths = new Set();
        seenPathDirtySet.set(ownDirtySet, seenPaths);
      }
      if (!seenPaths.has(pathStr)) {
        results.push({ path: pathSuffix, dirtySet: ownDirtySet });
        seenPaths.add(pathStr);
      }
    }

    // If no parents, we're done with this branch
    if (current.parents.size === 0) {
      return;
    }

    // Continue traversing up to other roots via ALL parent paths
    for (const parentRef of current.parents) {
      const parent = parentRef.ref.deref();
      if (!parent) continue;

      // Only skip if we'd create a cycle in THIS path
      if (pathStack.includes(parent)) continue;

      traverse(parent, [parentRef.key, ...pathSuffix], [...pathStack, parent]);
    }
  }

  traverse(meta, [], [meta]);

  // If no paths found (truly orphan proxy), use all dirty sets on this meta
  if (results.length === 0) {
    for (const dirtySet of meta.dirtySets) {
      results.push({ path: [], dirtySet });
    }
  }

  return results;
}

function addParentRef(meta: ProxyMeta, parent: ProxyMeta, key: string): void {
  // Check if this exact parent+key combo already exists
  for (const existing of meta.parents) {
    if (existing.ref.deref() === parent && existing.key === key) {
      return; // Already registered
    }
  }
  meta.parents.add({ ref: new WeakRef(parent), key });
}

// Propagate dirty sets down the tree (for cross-model sharing)
function propagateDirtySets(meta: ProxyMeta, dirtySet: Set<string>): void {
  if (meta.dirtySets.has(dirtySet)) return;

  meta.dirtySets.add(dirtySet);

  // Propagate to all children
  for (const childMeta of meta.children.values()) {
    propagateDirtySets(childMeta, dirtySet);
  }
}

export function createTrackedProxy(
  target: object,
  path: string[],
  dirtySet: Set<string>,
  parent?: ProxyMeta,
  keyInParent?: string,
): object {
  // Check cache first (handles circular refs and cross-model sharing)
  const cached = proxyCache.get(target);
  if (cached) {
    const cachedMeta = metaCache.get(cached);
    if (cachedMeta) {
      // Add the new dirty set (for cross-model sharing)
      propagateDirtySets(cachedMeta, dirtySet);

      if (parent && keyInParent) {
        addParentRef(cachedMeta, parent, keyInParent);
        parent.children.set(keyInParent, cachedMeta);
      }
    }
    return cached;
  }

  const meta: ProxyMeta = {
    path,
    dirtySets: new Set([dirtySet]),
    parents: new Set(parent && keyInParent ? [{ ref: new WeakRef(parent), key: keyInParent }] : []),
    children: new Map(),
    target,
    proxy: null!, // Will be set below
  };

  // If this is a root (no parent), register its dirty set
  if (!parent) {
    rootDirtySetMap.set(meta, dirtySet);
  }

  const proxy: object = new Proxy(target, {
    get(obj, prop, receiver) {
      // Handle our internal symbols - return directly from target
      if (
        prop === MODEL_INTERNALS ||
        prop === OBSERVABLE_META ||
        prop === PROXY_META
      ) {
        return Reflect.get(obj, prop);
      }

      // Pass through well-known symbols for native behavior
      // (iteration, inspection, type coercion, etc.)
      if (typeof prop === 'symbol' && PASSTHROUGH_SYMBOLS.has(prop)) {
        const value = Reflect.get(obj, prop, obj);
        // Don't bind dispose functions - they may be non-configurable and
        // the proxy must return the exact value to satisfy proxy invariants
        if (prop === Symbol.dispose || prop === Symbol.asyncDispose) {
          return value;
        }
        // Bind other functions to target for proper behavior
        if (typeof value === 'function') {
          return value.bind(obj);
        }
        return value;
      }

      // Built-ins with internal slots need to bypass proxy for all property access
      // (both methods and getters like .size check internal slots)
      if (hasInternalSlots(obj)) {
        const value = Reflect.get(obj, prop, obj); // Use obj as receiver, not proxy
        if (typeof value === 'function') {
          // Wrap mutating methods to track dirty
          if (isMutatingMethod(obj, prop)) {
            return function (this: unknown, ...args: unknown[]) {
              const result = value.apply(obj, args);
              // Mark this built-in container and its parents as dirty
              markContainerDirty(meta);
              return result;
            };
          }
          return value.bind(obj);
        }
        return value;
      }

      const value = Reflect.get(obj, prop, receiver);

      // Bind functions to the proxy so `this.foo = x` triggers dirty tracking
      if (typeof value === 'function') {
        return value.bind(proxy);
      }

      // Return cached child proxy if exists
      if (meta.children.has(prop)) {
        const childMeta = meta.children.get(prop)!;
        return childMeta.proxy;
      }

      // Wrap objects/arrays in proxies
      if (value !== null && typeof value === 'object') {
        // Check if value is already a proxy (from another model/observable)
        const existingMeta = metaCache.get(value);
        if (existingMeta) {
          // Connect existing proxy to this tree
          addParentRef(existingMeta, meta, String(prop));
          meta.children.set(prop, existingMeta);
          // Propagate our dirty sets to the existing proxy
          for (const ds of meta.dirtySets) {
            propagateDirtySets(existingMeta, ds);
          }
          return existingMeta.proxy;
        }

        const childProxy = createTrackedProxy(
          value as object,
          [...path, String(prop)],
          dirtySet,
          meta,
          String(prop),
        );
        const childMeta = metaCache.get(childProxy);
        if (childMeta) {
          meta.children.set(prop, childMeta);
        }
        return childProxy;
      }

      return value;
    },

    set(obj, prop, value, _receiver) {
      const oldValue = Reflect.get(obj, prop, obj);

      // Check if setting the same proxy reference back (no change)
      const existingChild = meta.children.get(prop);
      if (existingChild && existingChild.proxy === value) {
        return true; // Same proxy, no change needed
      }

      // Clear old child tracking (for any value change, not just objects)
      meta.children.delete(prop);

      const result = Reflect.set(obj, prop, value, obj);

      // Track dirty if value changed (including setting to undefined)
      if (oldValue !== value) {
        markDirtyWithParents(meta, prop);
      }

      return result;
    },

    deleteProperty(obj, prop) {
      // Mark dirty BEFORE deleting so we can still traverse
      markDirtyWithParents(meta, prop);

      // Clean up child tracking
      meta.children.delete(prop);

      return Reflect.deleteProperty(obj, prop);
    },

    // Transparency traps - make proxy behave like native object
    has(obj, prop) {
      return Reflect.has(obj, prop);
    },

    ownKeys(obj) {
      return Reflect.ownKeys(obj);
    },

    getOwnPropertyDescriptor(obj, prop) {
      return Reflect.getOwnPropertyDescriptor(obj, prop);
    },

    getPrototypeOf(obj) {
      return Reflect.getPrototypeOf(obj);
    },

    isExtensible(obj) {
      return Reflect.isExtensible(obj);
    },

    preventExtensions(obj) {
      return Reflect.preventExtensions(obj);
    },

    defineProperty(obj, prop, descriptor) {
      const result = Reflect.defineProperty(obj, prop, descriptor);
      // Don't mark internal symbols as dirty
      if (
        result &&
        'value' in descriptor &&
        prop !== MODEL_INTERNALS &&
        prop !== OBSERVABLE_META &&
        prop !== Symbol.dispose &&
        prop !== Symbol.asyncDispose
      ) {
        markDirtyWithParents(meta, prop);
      }
      return result;
    },

    setPrototypeOf(obj, proto) {
      return Reflect.setPrototypeOf(obj, proto);
    },
  });

  meta.proxy = proxy;
  proxyCache.set(target, proxy);
  metaCache.set(proxy, meta);

  return proxy;
}

// Get proxy metadata (for debugging/testing)
export function getProxyMeta(proxy: object): ProxyMeta | undefined {
  return metaCache.get(proxy);
}

// Check if an object is already a tracked proxy
export function isTrackedProxy(obj: unknown): boolean {
  return obj !== null && typeof obj === 'object' && metaCache.has(obj);
}
