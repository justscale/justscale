/**
 * Built-in ProcessDescriptor implementations for framework types.
 *
 * These register [Symbol.process] on standard JS and framework types
 * so they're automatically handled by the Processable protocol in
 * durable processes, channels, and signals.
 *
 * Import this module for side effects — it registers all builtins.
 */

import { registerProcessType } from './serialization.js';
import { Reference } from '../models/reference/reference.js';
import { References } from '../models/reference/reference.js';
import { getModelByName } from '../models/model-name-registry.js';

// Ensure Symbol.process exists
import './serialization.js';

/**
 * Define [Symbol.process] on a constructor if not already set.
 * Idempotent — safe to call multiple times (ESM re-imports).
 */
function defineProcessable<T>(target: object, descriptor: ProcessDescriptor<T>): void {
  if (!Object.prototype.hasOwnProperty.call(target, Symbol.process)) {
    Object.defineProperty(target, Symbol.process, {
      value: descriptor,
      enumerable: false,
      configurable: false,
    });
  }
  registerProcessType(descriptor);
}

// ============================================================================
// Date
// ============================================================================

const INVALID_DATE_SENTINEL = 'invalid';

defineProcessable<Date>(Date, {
  name: 'justscale.Date',
  serialize: (value: Date) => {
    const ms = value.getTime();
    return { ms: Number.isNaN(ms) ? INVALID_DATE_SENTINEL : ms };
  },
  deserialize: (data: Uint8Array | object) => {
    const { ms } = data as { ms: number | typeof INVALID_DATE_SENTINEL };
    return ms === INVALID_DATE_SENTINEL ? new Date(NaN) : new Date(ms as number);
  },
  validate: (payload: unknown): boolean => {
    if (payload == null || typeof payload !== 'object') return false;
    const { ms } = payload as { ms: unknown };
    return typeof ms === 'number' || ms === INVALID_DATE_SENTINEL;
  },
});

// ============================================================================
// Map
// ============================================================================

defineProcessable<Map<unknown, unknown>>(Map, {
  name: 'justscale.Map',
  serialize: (value: Map<unknown, unknown>) => ({
    entries: Array.from(value.entries()),
  }),
  deserialize: (data: Uint8Array | object) =>
    new Map((data as { entries: [unknown, unknown][] }).entries),
  validate: (payload: unknown): boolean => {
    if (payload == null || typeof payload !== 'object') return false;
    const { entries } = payload as { entries: unknown };
    return Array.isArray(entries);
  },
});

// ============================================================================
// Set
// ============================================================================

defineProcessable<Set<unknown>>(Set, {
  name: 'justscale.Set',
  serialize: (value: Set<unknown>) => ({
    items: Array.from(value),
  }),
  deserialize: (data: Uint8Array | object) =>
    new Set((data as { items: unknown[] }).items),
  validate: (payload: unknown): boolean => {
    if (payload == null || typeof payload !== 'object') return false;
    const { items } = payload as { items: unknown };
    return Array.isArray(items);
  },
});

// ============================================================================
// Reference<T>
// ============================================================================

defineProcessable<Reference<unknown>>(Reference, {
  name: 'justscale.Reference',
  serialize: (value: Reference<unknown>) => ({
    id: value.identifier,
    ...(value.modelName ? { m: value.modelName } : {}),
  }),
  deserialize: (data: Uint8Array | object) => {
    const { id, m } = data as { id: string; m?: string };
    if (m) {
      const model = getModelByName(m);
      if (model) return model.ref(id);
    }
    return new Reference(id);
  },
  validate: (payload: unknown): boolean => {
    if (payload == null || typeof payload !== 'object') return false;
    const { id } = payload as { id: unknown };
    return typeof id === 'string';
  },
});

defineProcessable<References<unknown>>(References, {
  name: 'justscale.References',
  serialize: (value: References<unknown>) => ({ ids: [...value.identifiers] }),
  deserialize: (data: Uint8Array | object) =>
    new References((data as { ids: string[] }).ids),
  validate: (payload: unknown): boolean => {
    if (payload == null || typeof payload !== 'object') return false;
    const { ids } = payload as { ids: unknown };
    return Array.isArray(ids);
  },
});

// ============================================================================
// RegExp
// ============================================================================

defineProcessable<RegExp>(RegExp, {
  name: 'justscale.RegExp',
  serialize: (value: RegExp) => ({ source: value.source, flags: value.flags }),
  deserialize: (data: Uint8Array | object) => {
    const { source, flags } = data as { source: string; flags: string };
    return new RegExp(source, flags);
  },
  validate: (payload: unknown): boolean => {
    if (payload == null || typeof payload !== 'object') return false;
    const { source, flags } = payload as { source: unknown; flags: unknown };
    return typeof source === 'string' && typeof flags === 'string';
  },
});

// ============================================================================
// Error + common subclasses
// ============================================================================

type ErrorPayload = { name: string; message: string; stack?: string; cause?: unknown };

function serializeError(value: Error): ErrorPayload {
  const payload: ErrorPayload = { name: value.name, message: value.message };
  if (value.stack !== undefined) payload.stack = value.stack;
  if ((value as any).cause !== undefined) payload.cause = (value as any).cause;
  return payload;
}

function deserializeAsError(data: Uint8Array | object): Error {
  const { name, message, stack, cause } = data as ErrorPayload;
  const e = new Error(message);
  e.name = name;
  if (stack !== undefined) e.stack = stack;
  if (cause !== undefined) (e as any).cause = cause;
  return e;
}

function validateErrorPayload(payload: unknown): boolean {
  if (payload == null || typeof payload !== 'object') return false;
  const { name, message } = payload as { name: unknown; message: unknown };
  return typeof name === 'string' && typeof message === 'string';
}

defineProcessable<Error>(Error, {
  name: 'justscale.Error',
  serialize: serializeError,
  deserialize: deserializeAsError,
  validate: validateErrorPayload,
} as ProcessDescriptor<Error>);

// Common Error subclasses — registered separately so instanceof works after round-trip.
const ERROR_SUBCLASSES: ReadonlyArray<[string, new (message?: string) => Error]> = [
  ['justscale.TypeError', TypeError],
  ['justscale.RangeError', RangeError],
  ['justscale.SyntaxError', SyntaxError],
  ['justscale.ReferenceError', ReferenceError],
  ['justscale.URIError', URIError],
  ['justscale.EvalError', EvalError],
];

for (const [descriptorName, Ctor] of ERROR_SUBCLASSES) {
  // defineProcessable also calls registerProcessType, so only call it once.
  defineProcessable<Error>(Ctor, {
    name: descriptorName,
    serialize: serializeError,
    deserialize: (data: Uint8Array | object): Error => {
      const { name, message, stack, cause } = data as ErrorPayload;
      const e = new Ctor(message);
      e.name = name;
      if (stack !== undefined) e.stack = stack;
      if (cause !== undefined) (e as any).cause = cause;
      return e;
    },
    validate: validateErrorPayload,
  } as ProcessDescriptor<Error>);
}

// ============================================================================
// BigInt
// ============================================================================

// BigInt is a primitive, not a class — instances don't have a constructor
// with [Symbol.process]. Instead, the state serializer's nested Processable
// check won't catch it (typeof bigint !== 'object'). BigInt is already
// handled by the state serializer's __$type:'BigInt' tag for the legacy path.
// We register the descriptor so it's available for explicit use and
// for the compiler's codegen wrapping.
registerProcessType({
  name: 'justscale.BigInt',
  serialize: (value: bigint) => ({ v: value.toString() }),
  deserialize: (data: Uint8Array | object) => BigInt((data as { v: string }).v),
  validate: (payload: unknown): boolean => {
    if (payload == null || typeof payload !== 'object') return false;
    const { v } = payload as { v: unknown };
    return typeof v === 'string';
  },
} as ProcessDescriptor);

// ============================================================================
// Type augmentations so TypeScript knows these constructors have Symbol.process
// ============================================================================

declare global {
  interface DateConstructor extends Processable<Date> {}
  interface MapConstructor extends Processable<Map<unknown, unknown>> {}
  interface SetConstructor extends Processable<Set<unknown>> {}
}
