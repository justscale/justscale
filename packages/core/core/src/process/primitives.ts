/**
 * @justscale/process - Signal Primitives
 *
 * These functions provide the developer API for process control flow.
 * The actual behavior is implemented through compiler transforms that convert
 * calls to these functions into opcodes for the process runtime.
 */

import type { Signal } from './types.js';

// ============================================================================
// Durable Iterator Protocol
// ============================================================================

/**
 * Symbol for getting the current cursor from a durable iterator.
 * Called by runtime before suspension to persist position.
 */
export const DurableCursor = Symbol.for('justscale:DurableCursor');

/**
 * Symbol for restoring an iterator from a saved cursor.
 * Called by runtime on resume to continue iteration.
 */
export const FromCursor = Symbol.for('justscale:FromCursor');

/**
 * A cursor is the serializable "bookmark" into an iteration.
 * Must be JSON-serializable (primitives, arrays, plain objects).
 */
export type DurableCursorType = string | number | { [key: string]: DurableCursorType } | DurableCursorType[];

/**
 * Protocol for durable iteration.
 * Iterables implementing this can be used in for-of loops with suspension.
 */
export interface DurableIterable<T> {
  /**
   * Get current cursor position.
   * Called by runtime before suspension to persist position.
   */
  [DurableCursor](): DurableCursorType

  /**
   * Create iterator from a saved cursor.
   * Called by runtime on resume to continue iteration.
   */
  [FromCursor](cursor: DurableCursorType): AsyncIterableIterator<T>
}

/**
 * Wrapper that makes regular arrays durable.
 * The cursor is simply the index.
 */
export class DurableArrayIterator<T> implements DurableIterable<T>, AsyncIterableIterator<T> {
  private index: number;

  constructor(
    private readonly items: readonly T[],
    initialCursor?: DurableCursorType
  ) {
    if (typeof initialCursor === 'number' && Number.isFinite(initialCursor)) {
      // Floor non-integers, clamp to valid range [0, items.length]
      // Upper bound is items.length (not length-1) to allow "done" position
      const floored = Math.floor(initialCursor);
      this.index = Math.max(0, Math.min(floored, items.length));
    } else {
      // NaN, Infinity, strings, objects, etc. all reset to 0
      this.index = 0;
    }
  }

  [DurableCursor](): DurableCursorType {
    return this.index;
  }

  [FromCursor](cursor: DurableCursorType): AsyncIterableIterator<T> {
    return new DurableArrayIterator(this.items, cursor);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.index >= this.items.length) {
      return { done: true, value: undefined };
    }
    const value = this.items[this.index];
    this.index++;
    return { done: false, value };
  }
}

/**
 * Branded interface for durable query iteration.
 * The compiler detects this type to allow for-of loops over repository queries
 * in durable processes with proper suspend/resume via keyset pagination.
 */
export interface DurableQueryIterable<T, TCursor = Record<string, string | number>>
  extends AsyncIterable<T>, DurableIterable<T> {
  readonly __durableIterator: true
  readonly __cursorType: TCursor
  readonly orderBy: string[]
}

/**
 * Check if a value implements the durable iterator protocol.
 */
export function isDurableIterable<T>(value: unknown): value is DurableIterable<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    DurableCursor in value &&
    FromCursor in value
  );
}

/**
 * Create a durable iterator from an array.
 * If a cursor is provided, resumes from that position.
 */
export function createDurableArrayIterator<T>(
  items: readonly T[],
  cursor?: DurableCursorType
): DurableArrayIterator<T> {
  return new DurableArrayIterator(items, cursor);
}

// ============================================================================
// Duration Type
// ============================================================================

/**
 * Represents a time duration in milliseconds.
 * Used with the delay primitive for timer signals.
 */
export interface Duration {
  /** Duration in milliseconds */
  readonly ms: number
}

// ============================================================================
// Signal Primitives
// ============================================================================

/** Symbol to identify signal placeholders at runtime */
const SIGNAL_PLACEHOLDER = Symbol.for('@justscale/process/signal');

/** Symbol to identify signal.all() placeholders at runtime. Cross-realm with tests. */
const SIGNAL_ALL_PLACEHOLDER = Symbol.for('@justscale/process/signal.all');

/** Symbol to identify signal.settled() placeholders at runtime. Cross-realm with tests. */
const SIGNAL_SETTLED_PLACEHOLDER = Symbol.for('@justscale/process/signal.settled');

/** Symbol to identify race placeholders at runtime. Cross-realm with tests. */
const RACE_PLACEHOLDER = Symbol.for('@justscale/process/race');

/** Symbol to identify delay placeholders at runtime. Cross-realm with tests. */
const DELAY_PLACEHOLDER = Symbol.for('@justscale/process/delay');

/**
 * Wait for a signal inside a process, or use as a case discriminant in race().
 *
 * **Awaiting a signal (single arg):**
 * When awaited inside a process handler, this suspends the process until
 * the signal is emitted and returns the payload.
 *
 * **In a race switch (two args):**
 * Pass the race result as first arg to narrow its type in the case branch.
 *
 * The compiler transforms this into appropriate opcodes.
 *
 * @example
 * ```typescript
 * // Simple wait
 * const payload = await signal(orders.complete)
 *
 * // Race with narrowing - pass r to narrow its type
 * const r = race()
 * switch (r) {
 *   case signal(r, orders.complete):
 *     // r is narrowed to the payload type
 *     console.log(r.orderId)
 *     break
 *   case delay.hours(r, 24):
 *     // timeout
 *     break
 * }
 * ```
 */

function signalImpl(
  this: unknown,
  ...args: unknown[]
): unknown {
  // Two distinct overloads, disambiguated by arity (not coalescing):
  //   signal(signalDef)            - arg0 is the target
  //   signal(racer, signalDef)     - arg1 is the target
  // Passing `undefined` explicitly for the target is a caller bug, not a
  // legitimate "fall back to the other arg" signal. We error loudly so
  // race() misuse doesn't silently resolve to the race context itself.
  let target: unknown;
  if (args.length >= 2) {
    if (args[0] === undefined) {
      throw new TypeError('signal() target is undefined');
    }
    target = args[1];
    if (target === undefined) {
      throw new TypeError('signal() target is undefined');
    }
  } else if (args.length === 1) {
    target = args[0];
    if (target === undefined) {
      throw new TypeError('signal() target is undefined');
    }
  } else {
    throw new TypeError('signal() requires a target');
  }
  return {
    [SIGNAL_PLACEHOLDER]: true,
    signal: target,
  };
}

/**
 * Result type for signal.settled() - matches Promise.allSettled behavior
 */
export type SettledResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: Error };

/**
 * Type helper to extract payloads from signal array
 */
type ExtractPayloads<T extends readonly unknown[]> = {
  [K in keyof T]: T[K] extends Signal<any, infer P, any> ? P : T[K] extends () => Promise<infer R> ? R : unknown
};

/**
 * Type helper to extract payloads from signal object
 */
type ExtractPayloadsObj<T extends Record<string, unknown>> = {
  [K in keyof T]: T[K] extends Signal<any, infer P, any> ? P : T[K] extends () => Promise<infer R> ? R : unknown
};

/**
 * signal.all - Wait for all signals in parallel
 */
function signalAll<T extends readonly unknown[]>(signals: T): Promise<ExtractPayloads<T>>;
function signalAll<T extends Record<string, unknown>>(signals: T): Promise<ExtractPayloadsObj<T>>;
function signalAll<T extends readonly unknown[]>(racer: unknown, signals: T): racer is ExtractPayloads<T>;
function signalAll<T extends Record<string, unknown>>(racer: unknown, signals: T): racer is ExtractPayloadsObj<T>;
function signalAll(
  signalsOrRacer: unknown,
  maybeSignals?: unknown,
): unknown {
  const signals = maybeSignals ?? signalsOrRacer;
  const isRace = maybeSignals !== undefined;
  return {
    [SIGNAL_ALL_PLACEHOLDER]: true,
    signals,
    isRace,
  };
}

/**
 * signal.settled - Wait for all signals, collecting results (including failures)
 */
function signalSettled<T extends readonly unknown[]>(
  signals: T
): Promise<{ [K in keyof T]: SettledResult<ExtractPayloads<T>[K]> }>;
function signalSettled(signals: unknown): unknown {
  return {
    [SIGNAL_SETTLED_PLACEHOLDER]: true,
    signals,
  };
}

// Combine signal function with .all and .settled properties
interface SignalFunction {
  <TIdentity extends readonly unknown[], TPayload, TName extends string>(
    target: Signal<TIdentity, TPayload, TName>
  ): Promise<TPayload>

  <TIdentity extends readonly unknown[], TPayload, TName extends string>(
    racer: unknown,
    target: Signal<TIdentity, TPayload, TName>
  ): racer is TPayload

  /**
   * Wait for all signals in parallel.
   *
   * @example
   * ```typescript
   * // Array form - tuple result
   * const [a, b] = await signal.all([svc.taskA, svc.taskB])
   *
   * // Object form - named result
   * const { payment, shipping } = await signal.all({
   *   payment: orders.paid,
   *   shipping: orders.shipped,
   * })
   *
   * // In race - branch wins when ALL signals fire
   * const r = race()
   * switch (true) {
   *   case signal.all(r, [svc.paid, svc.verified]):
   *     return 'both confirmed'
   * }
   * ```
   */
  all: typeof signalAll

  /**
   * Wait for all signals, collecting results including failures.
   * Similar to Promise.allSettled behavior.
   *
   * @example
   * ```typescript
   * const results = await signal.settled([svc.taskA, svc.taskB])
   * // results: [{ status: 'fulfilled', value: T } | { status: 'rejected', reason: Error }, ...]
   * ```
   */
  settled: typeof signalSettled
}

export const signal: SignalFunction = Object.assign(signalImpl, {
  all: signalAll,
  settled: signalSettled,
}) as SignalFunction;

/**
 * Create a race context for waiting on multiple signals simultaneously.
 *
 * Used with a switch statement to handle whichever signal arrives first.
 * The compiler transforms this pattern into RACE_START and RACE_SUSPEND opcodes.
 *
 * @returns An unknown value that gets narrowed by signal()/delay() in switch cases
 *
 * @example
 * ```typescript
 * const r = race()
 * switch (r) {
 *   case signal(payment.received):
 *     // r is the payload type: { txId: string }
 *     return { status: 'paid', txId: r.txId }
 *
 *   case signal(payment.failed):
 *     return { status: 'failed', reason: r.reason }
 *
 *   case delay.hours(r, 24):
 *     return { status: 'timeout' }
 * }
 * ```
 */
export function race(): unknown {
  return {
    [RACE_PLACEHOLDER]: true,
  };
}

/**
 * Delay primitive for creating durable timer signals.
 *
 * When awaited inside a process, this suspends the process for the specified
 * duration. The timer is durable - if the process restarts, it will resume
 * from the correct time.
 *
 * Use the unit methods to specify the duration:
 * - `delay.seconds(n)` - Wait n seconds
 * - `delay.minutes(n)` - Wait n minutes
 * - `delay.hours(n)` - Wait n hours
 * - `delay.days(n)` - Wait n days
 *
 * Supports expressions: `delay.minutes(attempt * 5)`
 *
 * In a race switch, pass the race result as first arg.
 *
 * @example
 * ```typescript
 * // Simple delay
 * await delay.hours(24)
 * await delay.minutes(retryCount * 5)  // Expression support
 *
 * // In a race - pass r to match the pattern
 * const r = race()
 * switch (true) {
 *   case signal(r, orders.complete):
 *     console.log(r.orderId)
 *     break
 *   case delay.minutes(r, 5):
 *     // timeout - r is void here
 *     break
 * }
 * ```
 */
export interface DelayPrimitive {
  /** Wait for the specified number of seconds */
  seconds(n: number): Promise<void>
  seconds(racer: unknown, n: number): boolean

  /** Wait for the specified number of minutes */
  minutes(n: number): Promise<void>
  minutes(racer: unknown, n: number): boolean

  /** Wait for the specified number of hours */
  hours(n: number): Promise<void>
  hours(racer: unknown, n: number): boolean

  /** Wait for the specified number of days */
  days(n: number): Promise<void>
  days(racer: unknown, n: number): boolean
}

function createDelayMethod(unit: 'seconds' | 'minutes' | 'hours' | 'days') {
  const multipliers = {
    seconds: 1000,
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
  };
  const multiplier = multipliers[unit];

  return function (nOrRacer: number | unknown, maybeN?: number): unknown {
    const n = maybeN ?? (nOrRacer as number);
    // Validate delay duration
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error(`delay.${unit}() requires a finite number, got ${n}`);
    }
    if (n < 0) {
      throw new Error(`delay.${unit}() requires a non-negative number, got ${n}`);
    }
    return {
      [DELAY_PLACEHOLDER]: true,
      duration: { ms: n * multiplier },
      unit,
    };
  };
}

export const delay: DelayPrimitive = {
  seconds: createDelayMethod('seconds'),
  minutes: createDelayMethod('minutes'),
  hours: createDelayMethod('hours'),
  days: createDelayMethod('days'),
} as DelayPrimitive;

// ============================================================================
// Scope Primitive
// ============================================================================

/** Symbol to identify scope placeholders at runtime. Cross-realm with tests. */
const SCOPE_PLACEHOLDER = Symbol.for('@justscale/process/scope');

/**
 * Result type for scope with handler - collects results from each entity
 */
export type ScopeResult<R> = Map<string, R>;

/**
 * ID extractor function - extracts entity ID from an entity
 */
export type IdExtractor<T> = (entity: T) => string;

/**
 * Scope handler function - runs for each entity
 */
export type ScopeHandler<T, R> = (entity: T) => Promise<R>;

/**
 * Process scoped operations over a collection of entities.
 *
 * Scope allows you to run operations per-entity with proper identity routing.
 * Each entity gets its own execution context with path like `/scope_0/entity-123`.
 *
 * **Forms:**
 *
 * 1. Signal-first: Wait for a signal per entity
 * ```typescript
 * await scope(svc.itemProcessed, orderItems)
 * ```
 *
 * 2. Entities with handler: Run handler per entity
 * ```typescript
 * await scope(orderItems, async (item) => {
 *   await signal(svc.itemProcessed)
 *   return item.id
 * })
 * ```
 *
 * 3. Process reference: Spawn subprocess per entity
 * ```typescript
 * await scope(ItemProcessor, orderItems)
 * ```
 *
 * Entity identity is automatically derived: `OrderItem` → `orderItemId`
 *
 * @example
 * ```typescript
 * createProcess({
 *   path: '/order/:orderId/fulfillment',
 *   async handler({ svc }, [orderId]) {
 *     const order = await orders.get(orderId)
 *
 *     // Wait for each item to be processed
 *     await scope(svc.itemProcessed, order.items)
 *
 *     return { status: 'all_processed' }
 *   }
 * })
 * ```
 */
export interface ScopePrimitive {
  /**
   * Wait for a signal per entity.
   * Signal identity is automatically bound to each entity's ID.
   */
  <T, P>(signal: PromiseLike<P>, entities: Iterable<T>): Promise<Map<string, P>>

  /**
   * Wait for a signal per entity with custom ID extractor.
   */
  <T, P>(signal: PromiseLike<P>, entities: Iterable<T>, idFn: IdExtractor<T>): Promise<Map<string, P>>

  /**
   * Run a handler per entity.
   */
  <T, R>(entities: Iterable<T>, handler: ScopeHandler<T, R>): Promise<Map<string, R>>

  /**
   * Run a handler per entity with custom ID extractor.
   */
  <T, R>(entities: Iterable<T>, idFn: IdExtractor<T>, handler: ScopeHandler<T, R>): Promise<Map<string, R>>

  /**
   * Run a handler per entity with explicit parameter alias.
   */
  <T, R>(entities: Iterable<T>, alias: string, handler: ScopeHandler<T, R>): Promise<Map<string, R>>
}

function scopeImpl(...args: unknown[]): unknown {
  if (args.length >= 2) {
    const [first, second] = args;

    // Signal-first form: scope(signal, entities, ?idFn)
    if (typeof first === 'object' && first !== null && 'then' in first) {
      return {
        [SCOPE_PLACEHOLDER]: true,
        type: 'signal',
        signal: first,
        entities: second,
        idFn: args[2],
      };
    }

    // Entities-first form: scope(entities, handler) or scope(entities, idFn/alias, handler)
    if (typeof second === 'function') {
      return {
        [SCOPE_PLACEHOLDER]: true,
        type: 'handler',
        entities: first,
        handler: second,
      };
    }

    if (args.length >= 3 && typeof args[2] === 'function') {
      return {
        [SCOPE_PLACEHOLDER]: true,
        type: 'handler',
        entities: first,
        idFnOrAlias: second,
        handler: args[2],
      };
    }
  }

  throw new Error('Invalid scope() arguments');
}

export const scope: ScopePrimitive = scopeImpl as ScopePrimitive;

/** @internal Check if a value is a scope placeholder */
export function isScopePlaceholder(value: unknown): value is {
  type: 'signal' | 'handler'
  entities: unknown
  signal?: unknown
  handler?: unknown
  idFn?: unknown
  idFnOrAlias?: unknown
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    SCOPE_PLACEHOLDER in value
  );
}

// ============================================================================
// Internal: Runtime Detection Helpers
// ============================================================================

/** @internal Check if a value is a signal placeholder */
export function isSignalPlaceholder(value: unknown): value is { signal: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    SIGNAL_PLACEHOLDER in value
  );
}

/** @internal Check if a value is a race placeholder */
export function isRacePlaceholder(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    RACE_PLACEHOLDER in value
  );
}

/** @internal Check if a value is a delay placeholder */
export function isDelayPlaceholder(value: unknown): value is { duration: Duration } {
  return (
    typeof value === 'object' &&
    value !== null &&
    DELAY_PLACEHOLDER in value
  );
}

/** @internal Check if a value is a signal.all placeholder */
export function isSignalAllPlaceholder(value: unknown): value is { signals: unknown; isRace: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    SIGNAL_ALL_PLACEHOLDER in value
  );
}

/** @internal Check if a value is a signal.settled placeholder */
export function isSignalSettledPlaceholder(value: unknown): value is { signals: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    SIGNAL_SETTLED_PLACEHOLDER in value
  );
}

// ============================================================================
// Stream Primitive
// ============================================================================

/** Symbol to identify stream placeholders at runtime. Cross-realm with tests. */
const STREAM_PLACEHOLDER = Symbol.for('@justscale/process/stream');

/**
 * Wait for a stream message inside a process race.
 *
 * Streams can be used as suspension points in race patterns, allowing processes
 * to wake up when a message is published to an entity's stream field.
 *
 * **In a race switch (two args):**
 * Pass the race result as first arg to narrow its type in the case branch.
 * The stream must be a stream field on an entity (e.g., `order.statusUpdates`).
 *
 * The compiler transforms this into appropriate opcodes that subscribe to
 * stream signals with format: `stream:{tableName}:{entityId}:{fieldName}`
 *
 * @example
 * ```typescript
 * const Order = defineModel('Order', {
 *   statusUpdates: field.stream(StatusEvent),
 * })
 *
 * // In a process handler:
 * const order = await orders.findById(orderId)
 * const r = race()
 * switch (true) {
 *   case stream(r, order.statusUpdates):
 *     // r is narrowed to { value: StatusEvent }
 *     console.log('Order updated:', r.value.status)
 *     break
 *   case signal(r, payments.timeout):
 *     console.log('Payment timed out')
 *     break
 *   case delay.hours(r, 24):
 *     console.log('24 hour deadline reached')
 *     break
 * }
 * ```
 */
export interface StreamPrimitive {
  /**
   * Wait for a stream message in a race pattern.
   * The stream must be a field on an entity loaded from a repository.
   *
   * @param racer - The race context from race()
   * @param target - The stream field (e.g., entity.messages)
   * @returns Type guard that narrows racer to { value: T }
   */
  <T>(racer: unknown, target: AsyncIterable<T>): racer is { value: T }
}

// Implementation
function streamImpl<T>(
  racer: unknown,
  target: AsyncIterable<T>,
): unknown {
  return {
    [STREAM_PLACEHOLDER]: true,
    stream: target,
  };
}

export const stream: StreamPrimitive = streamImpl as StreamPrimitive;

/** @internal Check if a value is a stream placeholder */
export function isStreamPlaceholder(value: unknown): value is { stream: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    STREAM_PLACEHOLDER in value
  );
}
