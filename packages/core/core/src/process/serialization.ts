/**
 * Processable Protocol — unified serialization for durable processes,
 * channels, signals, and cluster transport.
 *
 * Types that implement `Processable<T>` via `Symbol.process` get automatic
 * serialization everywhere the framework persists or transmits data.
 *
 * - Proto types: codegen adds `[Symbol.process]` automatically
 * - Framework builtins (Reference, Date, Map, Set, BigInt): implemented internally
 * - User types: opt-in via `static [Symbol.process] = { name, serialize, deserialize }`
 * - Plain types: JSON fallback (existing behavior)
 */

// Register Symbol.process on the global Symbol object (idempotent)
;(Symbol as any).process ??= Symbol.for('@justscale/process');

/**
 * Runtime type registry — maps descriptor names to their ProcessDescriptor.
 * Used during deserialization to look up the right deserializer by name.
 */
const registry = new Map<string, ProcessDescriptor>();

export function registerProcessType<T>(descriptor: ProcessDescriptor<T>): void {
  const { name } = descriptor;
  if (name === '') {
    throw new Error(
      '[Processable] Descriptor name must not be empty — a codegen bug emitting "" would silently pollute the registry'
    );
  }
  if (name !== name.trim()) {
    throw new Error(
      `[Processable] Descriptor name '${name}' has leading or trailing whitespace — this is almost certainly a bug`
    );
  }
  if (name === PAYLOAD_TAG) {
    throw new Error(
      `[Processable] Descriptor name '${PAYLOAD_TAG}' conflicts with the envelope tag key and is reserved`
    );
  }
  if (registry.has(name)) {
    const existing = registry.get(name)!;
    if (existing !== descriptor) {
      throw new Error(
        `[Processable] Duplicate registration for '${name}' — each processable type must have a unique name`
      );
    }
    return;
  }
  registry.set(name, descriptor as ProcessDescriptor);
}

export function getProcessDescriptor(name: string): ProcessDescriptor | undefined {
  return registry.get(name);
}

export function getProcessRegistry(): ReadonlyMap<string, ProcessDescriptor> {
  return registry;
}

function checkProcessDescriptor(value: unknown): boolean {
  if (value == null) return false;
  const desc = (value as any)[Symbol.process];
  return (
    desc != null &&
    typeof desc === 'object' &&
    typeof desc.name === 'string' &&
    typeof desc.serialize === 'function' &&
    typeof desc.deserialize === 'function'
  );
}

/**
 * Runtime check: does this value (instance or schema) implement Processable?
 */
export function isProcessable(value: unknown): value is { [Symbol.process]: ProcessDescriptor } {
  return checkProcessDescriptor(value);
}

/**
 * Check if a constructor/schema has the Processable protocol.
 * Works with both plain objects and class constructors (static [Symbol.process]).
 */
export function hasProcessDescriptor(schema: unknown): schema is Processable {
  return checkProcessDescriptor(schema);
}

/**
 * Auto-register a Processable type in the registry.
 * Call this when a Processable type is first encountered at runtime.
 */
export function ensureRegistered(schema: Processable): void {
  const descriptor = schema[Symbol.process];
  registerProcessType(descriptor);
}

// ============================================================================
// Payload Encoding/Decoding
// ============================================================================

/** Tag for Processable-encoded payloads (signals, channels) */
const PAYLOAD_TAG = '__$p';

/**
 * Wire-format version. Increment this only when the envelope structure changes
 * in a way that older decoders cannot handle. Currently:
 *   version 1 — { __$p: name, __$v: 1, d: payload }
 *
 * Envelopes without __$v are treated as version 1 for backwards compatibility
 * (any data encoded before versioning was introduced still decodes correctly).
 */
const ENVELOPE_VERSION = 1;

/** Property key used by Lock<T> to carry lock metadata (defined in lock/types.ts). */
const LOCK_KEY = '__lock';

/**
 * Returns true when the value looks like a Lock<T> — it carries a __lock
 * metadata object and a Symbol.dispose slot, both assigned by LockServiceImpl.
 */
function isLockedValue(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    LOCK_KEY in (value as Record<string, unknown>) &&
    Symbol.dispose in (value as Record<symbol, unknown>)
  );
}

/**
 * Find the ProcessDescriptor for a value.
 * Checks instance directly, then constructor (for class instances).
 */
export function findProcessDescriptor(value: unknown): ProcessDescriptor | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const desc = (value as any)[Symbol.process];
  if (desc && typeof desc.serialize === 'function') return desc;
  const ctor = (value as any).constructor;
  if (ctor && ctor !== Object && ctor !== Array) {
    const ctorDesc = ctor[Symbol.process];
    if (ctorDesc && typeof ctorDesc.serialize === 'function') return ctorDesc;
  }
  return undefined;
}

/**
 * Encode a value using its Processable descriptor for JSON-safe storage.
 * Recursively walks plain objects and arrays to encode nested Processables.
 * Returns the original value unchanged if it's not Processable and contains none.
 *
 * Throws if a Locked<T> value is passed — lock guarantees must not cross a
 * wire. Unlock the value and send only the underlying reference.
 *
 * Throws with path context when a descriptor's serialize call fails.
 */
export function encodeProcessable(
  value: unknown,
  seen: Set<unknown> = new Set(),
  path = '<root>'
): unknown {
  if (isLockedValue(value)) {
    throw new Error(
      `[Processable] Cannot encode a Locked<T> value at path "${path}" — ` +
      'lock guarantees do not survive serialization. Unlock the value and ' +
      'send only the underlying reference or plain data.'
    );
  }

  const descriptor = findProcessDescriptor(value);
  if (descriptor) {
    let serialized: unknown;
    try {
      serialized = descriptor.serialize(value as any);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[Processable] encode failed at path "${path}": ${msg}`, { cause: err });
    }
    return { [PAYLOAD_TAG]: descriptor.name, __$v: ENVELOPE_VERSION, d: serialized };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError(`[Processable] cycle at ${path}`);
    }
    seen.add(value);
    const result = value.map((item, i) => encodeProcessable(item, seen, `${path}[${i}]`));
    seen.delete(value);
    return result;
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) {
      throw new TypeError(`[Processable] cycle at ${path}`);
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = encodeProcessable((value as Record<string, unknown>)[key], seen, `${path}.${key}`);
    }
    seen.delete(value);
    return result;
  }
  return value;
}

/**
 * Decode a value that may have been encoded via encodeProcessable.
 * Recursively walks plain objects and arrays to decode nested Processables.
 * Returns the original value unchanged if it wasn't encoded.
 *
 * When a descriptor has a `validate` function, the raw payload is checked
 * before deserialize is called. A failing validation throws with a clear
 * error, preventing type-confusion from mismatched __$p tags.
 */
export function decodeProcessable(value: unknown): unknown {
  if (
    value != null &&
    typeof value === 'object' &&
    PAYLOAD_TAG in (value as any) &&
    typeof (value as any)[PAYLOAD_TAG] === 'string'
  ) {
    const encoded = value as Record<string, unknown>;
    const name = encoded[PAYLOAD_TAG] as string;
    const version = '__$v' in encoded ? (encoded.__$v as number) : 1;
    if (version !== ENVELOPE_VERSION) {
      throw new Error(
        `[Processable] Unsupported envelope version ${version} for '${name}' — ` +
        `this runtime expects version ${ENVELOPE_VERSION}. ` +
        'Update both encoder and decoder when bumping the version.'
      );
    }
    const descriptor = getProcessDescriptor(name);
    if (descriptor) {
      if (typeof descriptor.validate === 'function' && !descriptor.validate(encoded.d)) {
        throw new Error(
          `[Processable] Payload shape validation failed for descriptor '${name}' — ` +
          'the envelope\'s payload does not match the expected shape. ' +
          'This indicates a corrupted or forged __$p tag.'
        );
      }
      return descriptor.deserialize(encoded.d as any);
    }
    throw new Error(
      `[Processable] Unknown descriptor '${name}' — type is not registered. ` +
      `Call registerProcessType({ name: '${name}', ... }) before deserializing. ` +
      'If you want permissive behaviour, catch this error and handle unknown descriptors yourself.'
    );
  }
  if (Array.isArray(value)) {
    return value.map(decodeProcessable);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = decodeProcessable((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}
