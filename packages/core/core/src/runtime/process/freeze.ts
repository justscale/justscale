const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export function freezeDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = freezeDeep(value[i]);
    return Object.freeze(value);
  }

  if (value instanceof Map) {
    for (const [k, v] of value) value.set(k, freezeDeep(v));
    return value;
  }

  if (value instanceof Set) return value;

  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      value[key] = freezeDeep(value[key]);
    }
    return Object.freeze(value);
  }

  // Class instances — don't freeze
  return value;
}

const mutationError = (method: string) => () => {
  throw new TypeError(`Cannot call .${method}() on a readonly collection`);
};

export function readonlyMapProxy<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  return new Proxy(map, {
    get(target, prop, receiver) {
      switch (prop) {
        case 'set':
        case 'delete':
        case 'clear':
          return mutationError(prop as string);
        case 'get': return (k: K) => target.get(k);
        case 'has': return (k: K) => target.has(k);
        case 'entries': return () => target.entries();
        case 'values': return () => target.values();
        case 'keys': return () => target.keys();
        case 'forEach': return (cb: (v: V, k: K, m: Map<K, V>) => void) => target.forEach(cb);
        case Symbol.iterator: return () => target[Symbol.iterator]();
        case 'size': return target.size;
        default: return Reflect.get(target, prop, receiver);
      }
    },
  }) as ReadonlyMap<K, V>;
}

export function readonlySetProxy<T>(set: Set<T>): ReadonlySet<T> {
  return new Proxy(set, {
    get(target, prop, receiver) {
      switch (prop) {
        case 'add':
        case 'delete':
        case 'clear':
          return mutationError(prop as string);
        case 'has': return (v: T) => target.has(v);
        case 'values': return () => target.values();
        case 'keys': return () => target.keys();
        case 'entries': return () => target.entries();
        case 'forEach': return (cb: (v: T, v2: T, s: Set<T>) => void) => target.forEach(cb);
        case Symbol.iterator: return () => target[Symbol.iterator]();
        case 'size': return target.size;
        default: return Reflect.get(target, prop, receiver);
      }
    },
  }) as ReadonlySet<T>;
}

export function freezeExports<T extends Record<string, unknown>>(
  data: T,
  methods?: Record<string, Function>,
): Readonly<T> {
  const result = {} as Record<string, unknown>;

  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Map) {
      result[key] = readonlyMapProxy(value);
    } else if (value instanceof Set) {
      result[key] = readonlySetProxy(value);
    } else {
      result[key] = freezeDeep(value);
    }
  }

  if (methods) {
    // Freeze data first so methods' `this` sees frozen data
    Object.freeze(result);
    const combined = Object.create(result);
    for (const [key, fn] of Object.entries(methods)) {
      combined[key] = fn.bind(result);
    }
    return Object.freeze(combined) as Readonly<T>;
  }

  return Object.freeze(result) as Readonly<T>;
}
