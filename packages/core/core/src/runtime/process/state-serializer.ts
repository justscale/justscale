/**
 * State serializer for durable process vars.
 *
 * Wraps non-JSON types (Map, Set, Date, BigInt, undefined) with type tags
 * so they survive JSONB round-trips. Uses `__$type` as the tag key to avoid
 * collisions with user data.
 *
 * Types implementing the Processable protocol (Symbol.process) get automatic
 * custom serialization. The `__types` metadata map tracks which variables
 * used Processable descriptors, enabling correct deserialization via the
 * runtime type registry.
 */

import { getProcessDescriptor, findProcessDescriptor } from '../../process/serialization.js';
import { PERSISTENT, ADAPTER_KEY } from '../../models/symbols.js';
import { MODEL_NAME } from '../../models/define-model.js';
import { getModelByName } from '../../models/model-name-registry.js';
import { Reference } from '../../models/reference/reference.js';

const TAG = '__$type';
const TYPES_KEY = '__$processTypes';

type Tagged = { [TAG]: string; v: unknown };

function isTagged(value: unknown): value is Tagged {
  return (
    typeof value === 'object' &&
    value !== null &&
    TAG in value &&
    typeof (value as Tagged)[TAG] === 'string'
  );
}

function serializeValue(value: unknown): unknown {
  if (value === undefined) {
    return { [TAG]: 'undefined' };
  }
  if (value === null) {
    return null;
  }
  if (typeof value === 'bigint') {
    return { [TAG]: 'BigInt', v: value.toString() };
  }
  if (typeof value === 'function') {
    console.warn('[state-serializer] Functions cannot be serialized — replacing with null');
    return null;
  }
  if (value instanceof Uint8Array) {
    return { [TAG]: 'Uint8Array', v: uint8ArrayToBase64(value) };
  }
  // Persistent entities collapse to References — never store stale entity data in process state.
  if (typeof value === 'object' && value !== null && (value as any)[PERSISTENT]) {
    const id = (value as any)[ADAPTER_KEY] as string | undefined;
    const modelName = (value as any).constructor?.[MODEL_NAME] as string | undefined;
    if (id) {
      return { [TAG]: 'PersistentRef', id, ...(modelName ? { m: modelName } : {}) };
    }
  }
  // Check Processable protocol for nested values (Date, Map, Set, Reference, custom types).
  // This handles nested Processable values inside arrays, objects, and other structures.
  // Top-level vars are handled separately by serializeState().
  if (typeof value === 'object' && !Array.isArray(value)) {
    const descriptor = findProcessDescriptor(value);
    if (descriptor) {
      const serialized = descriptor.serialize(value as any);
      return { [TAG]: 'P', n: descriptor.name, v: serializeValue(serialized) };
    }
  }
  // Legacy fallbacks for Date, Map, Set when builtin-serializers is not imported.
  // When builtins ARE imported, the Processable check above handles these.
  if (value instanceof Date) {
    return { [TAG]: 'Date', v: value.getTime() };
  }
  if (value instanceof Map) {
    const entries: [unknown, unknown][] = [];
    for (const [k, v] of value) {
      entries.push([serializeValue(k), serializeValue(v)]);
    }
    return { [TAG]: 'Map', v: entries };
  }
  if (value instanceof Set) {
    const items: unknown[] = [];
    for (const item of value) {
      items.push(serializeValue(item));
    }
    return { [TAG]: 'Set', v: items };
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = serializeValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  // string, number, boolean
  return value;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function deserializeValue(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(deserializeValue);
  }
  if (typeof value === 'object') {
    if (isTagged(value)) {
      switch (value[TAG]) {
        case 'undefined':
          return undefined;
        case 'BigInt':
          return BigInt(value.v as string);
        case 'Date':
          return new Date(value.v as number);
        case 'Uint8Array':
          return base64ToUint8Array(value.v as string);
        case 'Map': {
          const entries = value.v as [unknown, unknown][];
          return new Map(entries.map(([k, v]) => [deserializeValue(k), deserializeValue(v)]));
        }
        case 'Set': {
          const items = value.v as unknown[];
          return new Set(items.map(deserializeValue));
        }
        case 'PersistentRef': {
          // Persistent entity collapsed to a Reference
          const { id, m } = value as unknown as { id: string; m?: string };
          if (m) {
            const model = getModelByName(m);
            if (model) return model.ref(id);
          }
          return new Reference(id);
        }
        case 'P': {
          // Nested Processable value — look up descriptor by name
          const name = (value as any).n as string;
          const descriptor = getProcessDescriptor(name);
          if (descriptor) {
            const rawValue = deserializeValue((value as any).v);
            return descriptor.deserialize(rawValue as any);
          }
          console.warn(
            `[state-serializer] No registered ProcessDescriptor for '${name}' — ` +
            'falling back to raw value'
          );
          return deserializeValue((value as any).v);
        }
        default:
          // Unknown tag — treat as plain object (user data that happens to have __$type)
          break;
      }
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = deserializeValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  // string, number, boolean
  return value;
}

/**
 * Deep-serialize process vars for JSONB storage.
 * Non-JSON types are wrapped with `{__$type, v}` tags.
 *
 * Variables whose values implement Processable (Symbol.process) are
 * serialized using their custom descriptor. A `__types` metadata map
 * is added to track which variables used Processable serialization.
 */
export function serializeState(vars: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let types: Record<string, string> | undefined;

  for (const key of Object.keys(vars)) {
    // Skip internal metadata keys
    if (key === TYPES_KEY) continue;

    const value = vars[key];
    const descriptor = findProcessDescriptor(value);

    if (descriptor) {
      // Processable type — use custom serializer
      let serialized: unknown;
      try {
        serialized = descriptor.serialize(value as any);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[Processable] encode failed at path "vars.${key}": ${msg}`, { cause: err });
      }
      // Wrap the result through serializeValue to handle Uint8Array etc.
      result[key] = serializeValue(serialized);
      types ??= {};
      types[key] = descriptor.name;
    } else {
      result[key] = serializeValue(value);
    }
  }

  if (types) {
    result[TYPES_KEY] = types;
  }
  return result;
}

/**
 * Deep-deserialize process vars from JSONB storage.
 * Reconstructs tagged types back to their native JS equivalents.
 *
 * If `__types` metadata is present, variables are deserialized using
 * their registered Processable descriptors from the type registry.
 */
export function deserializeState(vars: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const types = vars[TYPES_KEY] as Record<string, string> | undefined;

  for (const key of Object.keys(vars)) {
    if (key === TYPES_KEY) continue;

    if (types && key in types) {
      // Processable type — look up descriptor by name
      const descriptor = getProcessDescriptor(types[key]);
      if (descriptor) {
        // First deserialize the storage form (e.g. base64 → Uint8Array)
        const rawValue = deserializeValue(vars[key]);
        result[key] = descriptor.deserialize(rawValue as any);
      } else {
        console.warn(
          `[state-serializer] No registered ProcessDescriptor for '${types[key]}' — ` +
          `falling back to JSON deserialization for var '${key}'`
        );
        result[key] = deserializeValue(vars[key]);
      }
    } else {
      result[key] = deserializeValue(vars[key]);
    }
  }

  return result;
}
