/**
 * @justscale/process - Process Executor
 *
 * Switch-based executor for durable processes.
 * Uses pluggable storage, signal bus, and timer scheduler.
 */

import { serializeState, deserializeState } from './state-serializer.js';
import { encodeProcessable, decodeProcessable } from '../../process/serialization.js';
import { defineAbstract } from '../../core/index.js';
import type { ServiceToken, Resolver, Container } from '../../core/index.js';
import { runInFullRequestScope, getRequestContext } from '../../core/context.js';
import type { LockProvider } from '../../index.js';
import { runWithLockTracking, DoubleLockError } from '../../features/lock/lock-service.js';
import {
  SIGNAL_BRAND,
  type CompiledSwitchProcess,
  type ExecutionContext,
  type ProcessContinuation,
  type ProcessExportsMetadata,
  type ProcessHandle,
  type ProcessStatus,
  type Signal,
  type SwitchProcessState,
  type SuspendConfig,
  type SuspendRaceBranch,
} from '../../process/types.js';
import {
  resolveStreamWildcard as resolveStreamWildcardUtil,
} from '../../process/stream-utils.js';
import type { ProcessStorage } from './storage.js';
import type { SignalBus, SignalMatch } from './signal-bus.js';
import type { TimerScheduler, TimerFired } from './timer-scheduler.js';
import { createTracer } from './trace.js';
import { freezeExports } from './freeze.js';

const { trace } = createTracer('ProcessExecutor');

// ============================================================================
// Helper Types
// ============================================================================

/** Deferred promise for process completion */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Nested subprocess state stored under `parent.vars['__sub:name:args']`.
 * User-space child variables live in `vars`; everything else is metadata
 * owned by the executor.
 */
interface SubBlob {
  vars: Record<string, unknown>
  step: number
  done: boolean
  result?: unknown
  raceBranches?: import('../../process/types.js').SuspendRaceBranch[]
  suspendSignal?: string
}

// ============================================================================
// Instance ID Generation
// ============================================================================

/**
 * Resolve a param value: if it has an `identifier` property (e.g. a Reference
 * or Model.ref(entity)), use that. Otherwise stringify.
 */
function resolveParam(value: unknown): string {
  if (value != null && typeof value === 'object' && 'identifier' in value) {
    return String((value as { identifier: unknown }).identifier);
  }
  return String(value);
}

import { applyTypesConfig } from '../../models/apply-types-config.js';

export function generateInstanceId(path: string, params: readonly unknown[]): string {
  let paramIndex = 0;
  const segments = path.split('/').filter(Boolean);

  const resolved = segments.map(segment => {
    if (segment.startsWith(':')) {
      const value = params[paramIndex++];
      if (value === undefined) {
        throw new Error(`Missing parameter for ${segment} in path ${path}`);
      }
      return resolveParam(value);
    }
    return segment;
  });

  return resolved.join('/');
}

/**
 * Detect whether an instanceId belongs to a subprocess and split it into
 * `${parentInstanceId}/${subKey}` where `subKey` starts with `__sub:`.
 * Returns { parentInstanceId: null, subKey: null } for non-subprocess IDs.
 * A subprocess may itself have subprocesses — we split at the LAST `/__sub:`
 * boundary so the direct parent is always returned.
 */
export function parseChildInstanceId(instanceId: string): { parentInstanceId: string | null; subKey: string | null } {
  const marker = '/__sub:';
  const idx = instanceId.lastIndexOf(marker);
  if (idx === -1) return { parentInstanceId: null, subKey: null };
  return {
    parentInstanceId: instanceId.slice(0, idx),
    subKey: instanceId.slice(idx + 1),
  };
}

/**
 * Resolve a path pattern with params to a concrete path.
 */
export function resolvePath(path: string, params: readonly unknown[]): string {
  let paramIndex = 0;
  return path.replace(/:([^/]+)/g, () => {
    const value = params[paramIndex++];
    if (value === undefined) {
      throw new Error(`Missing parameter in path ${path}`);
    }
    return String(value);
  });
}

/**
 * Extract identity map from path params.
 *
 * Throws on missing params to stay consistent with generateInstanceId.
 * A process that lacks a required path param must fail loudly on both
 * id generation and identity extraction; silent coercion to "undefined"
 * hides routing bugs.
 */
export function extractIdentity(
  path: string,
  params: readonly unknown[]
): Record<string, string> {
  const identity: Record<string, string> = {};
  let paramIndex = 0;

  const segments = path.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      const value = params[paramIndex++];
      if (value === undefined) {
        throw new Error(`Missing parameter for ${segment} in path ${path}`);
      }
      identity[name] = resolveParam(value);
    }
  }

  return identity;
}

// ============================================================================
// Process Handle Implementation
// ============================================================================

class ProcessHandleImpl<TResult, TExports = void> implements ProcessHandle<TResult, TExports> {
  private _data: any = undefined;
  private _dataProxy: any = undefined;
  // Broadcast set: each entry is a pending resolve for one independent iterator.
  // setExportsData fans out to ALL of them simultaneously.
  private _dataSubscribers = new Set<(data: any) => void>();
  private _done = false;

  private _status: ProcessStatus = 'pending';
  private _statusSubscribers = new Set<(status: ProcessStatus) => void>();

  constructor(
    public readonly id: string,
    public readonly path: string,
    private readonly getState: () => Promise<SwitchProcessState | null>,
    private readonly completionDeferred: Deferred<TResult>,
    private readonly cancelFn: (instanceId: string) => Promise<boolean>,
    private readonly exportsMetadata?: ProcessExportsMetadata,
  ) {
    // When the process completes, close all data iterators and status iterators
    this.completionDeferred.promise.then(() => {
      this._done = true;
      for (const resolve of this._dataSubscribers) resolve(undefined);
      this._dataSubscribers.clear();
      // Status was already pushed by updateStatus before resolve — no extra push needed
      for (const resolve of this._statusSubscribers) resolve(undefined as any);
      this._statusSubscribers.clear();
    }).catch(() => {
      this._done = true;
      for (const resolve of this._dataSubscribers) resolve(undefined);
      this._dataSubscribers.clear();
      for (const resolve of this._statusSubscribers) resolve(undefined as any);
      this._statusSubscribers.clear();
    });
  }

  get status(): ProcessStatus {
    return this._status;
  }

  updateStatus(status: ProcessStatus): void {
    this._status = status;
    for (const resolve of this._statusSubscribers) resolve(status);
    this._statusSubscribers.clear();
  }

  get statusChanges(): AsyncIterable<ProcessStatus> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        let localDone = false;
        let pendingCb: ((status: ProcessStatus) => void) | null = null;

        return {
          next(): Promise<IteratorResult<ProcessStatus>> {
            if (localDone || self._done) {
              return Promise.resolve({ value: undefined as any, done: true });
            }
            return new Promise<IteratorResult<ProcessStatus>>(resolve => {
              const cb = (status: ProcessStatus) => {
                pendingCb = null;
                self._statusSubscribers.delete(cb);
                if (status === undefined as any) {
                  localDone = true;
                  resolve({ value: undefined as any, done: true });
                } else {
                  resolve({ value: status, done: false });
                }
              };
              pendingCb = cb;
              self._statusSubscribers.add(cb);
            });
          },
          return(): Promise<IteratorResult<ProcessStatus>> {
            localDone = true;
            if (pendingCb !== null) {
              self._statusSubscribers.delete(pendingCb);
              pendingCb = null;
            }
            return Promise.resolve({ value: undefined as any, done: true });
          },
        };
      },
    };
  }

  get result(): TResult | undefined {
    return undefined; // Must await for result via wait()
  }

  get error(): Error | undefined {
    return undefined; // Must check via wait()
  }

  get data(): any {
    if (this._data === undefined) return undefined;
    if (this._dataProxy) return this._dataProxy;

    const self = this;
    const base = this._data;

    if (typeof base !== 'object' || base === null) return base;
    if (base[Symbol.asyncIterator]) return base;

    // Create and cache a Proxy that adds Symbol.asyncIterator.
    // Each call to [Symbol.asyncIterator]() creates an INDEPENDENT subscriber
    // that receives every broadcast snapshot (fan-out, not fan-in).
    this._dataProxy = new Proxy(base, {
      get(_target, prop, _receiver) {
        if (prop === Symbol.asyncIterator) {
          return function() {
            // Late subscribers immediately receive the current snapshot, then wait for subsequent broadcasts.
            let seededInitial = false;
            let localDone = false;
            let cb: ((data: any) => void) | null = null;

            return {
              next(): Promise<IteratorResult<any>> {
                if (localDone) return Promise.resolve({ value: undefined, done: true } as const);
                if (!seededInitial) {
                  seededInitial = true;
                  if (self._data !== undefined) {
                    return Promise.resolve({ value: self._data, done: false });
                  }
                }
                if (self._done) return Promise.resolve({ value: undefined, done: true } as const);
                return new Promise<IteratorResult<any>>(resolve => {
                  cb = (newData: any) => {
                    cb = null;
                    if (newData === undefined) {
                      localDone = true;
                      resolve({ value: undefined, done: true });
                    } else {
                      resolve({ value: newData, done: false });
                    }
                  };
                  self._dataSubscribers.add(cb);
                });
              },
              return(): Promise<IteratorResult<any>> {
                localDone = true;
                if (cb !== null) {
                  const pendingCb = cb;
                  cb = null;
                  self._dataSubscribers.delete(pendingCb);
                  // Resolve the pending next() with done so the caller unblocks
                  pendingCb(undefined);
                }
                return Promise.resolve({ value: undefined, done: true } as const);
              },
            };
          };
        }
        // For non-asyncIterator access, read from the LATEST _data (not the original base)
        return Reflect.get(self._data, prop, _receiver);
      },
    });

    return this._dataProxy;
  }

  /** Set the exports data (called by executor after loading/updating state) */
  setExportsData(data: unknown): void {
    this._data = data;
    const subs = [...this._dataSubscribers];
    this._dataSubscribers.clear();
    for (const resolve of subs) {
      resolve(data);
    }
  }

  wait(): Promise<TResult> {
    return this.completionDeferred.promise;
  }

  cancel(): Promise<boolean> {
    return this.cancelFn(this.id);
  }

  /** Update cached status from storage (kept for backwards compat) */
  async refresh(): Promise<void> {
    const state = await this.getState();
    if (state) {
      this.updateStatus(state.status);
    }
  }
}

// ============================================================================
// Yield Queue (for generator processes)
// ============================================================================

/**
 * In-memory yield queue for live consumers of a generator process.
 * Buffered values are also persisted in state.vars.__yields by the executor.
 */
interface YieldQueue {
  /** Push a value to all live consumers */
  push(value: unknown): void
  /** Signal that the process has completed */
  complete(): void
  /** Register a live consumer. Returns unsubscribe function. */
  subscribe(callback: (value: unknown) => void, onComplete: () => void): () => void
}

function createYieldQueue(): YieldQueue {
  const consumers: Array<{ callback: (value: unknown) => void; onComplete: () => void }> = [];
  let completed = false;

  return {
    push(value: unknown) {
      for (const consumer of consumers) {
        consumer.callback(value);
      }
    },
    complete() {
      completed = true;
      for (const consumer of consumers) {
        consumer.onComplete();
      }
      consumers.length = 0;
    },
    subscribe(callback, onComplete) {
      if (completed) {
        onComplete();
        return () => {};
      }
      const entry = { callback, onComplete };
      consumers.push(entry);
      return () => {
        const idx = consumers.indexOf(entry);
        if (idx !== -1) consumers.splice(idx, 1);
      };
    },
  };
}

// ============================================================================
// Process Continuation Implementation
// ============================================================================

class ProcessContinuationImpl<TYield, TReturn> implements ProcessContinuation<TYield, TReturn> {
  private _status: ProcessStatus;
  private cursor: number;
  private readonly completionDeferred: Deferred<TReturn>;
  private readonly persistCursor: (consumerId: string, cursor: number) => Promise<void>;

  constructor(
    public readonly id: string,
    public readonly consumerId: string,
    initialCursor: number,
    initialStatus: ProcessStatus,
    private readonly yieldQueue: YieldQueue,
    private readonly getYieldsFromStorage: () => Promise<unknown[]>,
    completionDeferred: Deferred<TReturn>,
    persistCursor: (consumerId: string, cursor: number) => Promise<void>,
  ) {
    this._status = initialStatus;
    this.cursor = initialCursor;
    this.completionDeferred = completionDeferred;
    this.persistCursor = persistCursor;
  }

  get status(): ProcessStatus {
    return this._status;
  }

  get result(): Promise<TReturn> {
    return this.completionDeferred.promise;
  }

  async cancel(): Promise<void> {
    await this.persistCursor(this.consumerId, this.cursor);
  }

  [Symbol.asyncIterator](): AsyncIterator<TYield> {
    let unsubscribe: (() => void) | null = null;
    let pendingResolve: ((value: IteratorResult<TYield>) => void) | null = null;
    const buffer: unknown[] = [];
    let done = false;
    let storageHighWater = 0;
    const self = this;

    // Subscribe to live yield events
    unsubscribe = this.yieldQueue.subscribe(
      (value) => {
        if (pendingResolve) {
          const resolve = pendingResolve;
          pendingResolve = null;
          self.cursor++;
          resolve({ value: value as TYield, done: false });
        } else {
          buffer.push(value);
        }
      },
      () => {
        done = true;
        if (pendingResolve) {
          const resolve = pendingResolve;
          pendingResolve = null;
          resolve({ value: undefined as TYield, done: true });
        }
      }
    );

    return {
      async next(): Promise<IteratorResult<TYield>> {
        // First: drain any yields from storage that we haven't consumed yet
        const storedYields = await self.getYieldsFromStorage();

        // Discard buffer items that are now also in storage (both paths receive the same values)
        const newInStorage = storedYields.length - storageHighWater;
        if (newInStorage > 0) {
          buffer.splice(0, newInStorage);
          storageHighWater = storedYields.length;
        }

        if (self.cursor < storedYields.length) {
          const value = storedYields[self.cursor++];
          return { value: value as TYield, done: false };
        }

        // Then: check live buffer (only items beyond storage)
        if (buffer.length > 0) {
          self.cursor++;
          return { value: buffer.shift() as TYield, done: false };
        }

        // Then: check if already done
        if (done) {
          return { value: undefined as TYield, done: true };
        }

        // Wait for next live value or completion
        return new Promise<IteratorResult<TYield>>((resolve) => {
          pendingResolve = resolve;
        });
      },

      async return(): Promise<IteratorResult<TYield>> {
        unsubscribe?.();
        unsubscribe = null;
        await self.persistCursor(self.consumerId, self.cursor);
        return { value: undefined as TYield, done: true };
      },
    };
  }
}

// ============================================================================
// Executor Options
// ============================================================================

export interface ExportsPublishPayload {
  instanceId: string
  processId: string
  exports: Record<string, unknown>
}

export interface ProcessExecutorOptions {
  /** DI container for context propagation (optional - if not provided, context won't be propagated) */
  container?: Container
  /** Resolver function for resolving service dependencies */
  resolve: Resolver
  /** Storage backend for process state */
  storage: ProcessStorage
  /** Signal bus for routing signals */
  signalBus: SignalBus
  /** Timer scheduler for delays */
  timerScheduler: TimerScheduler
  /** Lock provider for exclusive process execution (optional for backwards compat) */
  lockProvider?: LockProvider
  /** Callback to publish exports changes (wired by infrastructure layer to channel backend) */
  publishExports?: (payload: ExportsPublishPayload) => Promise<void>
}

// ============================================================================
// Process Executor Interface & Token
// ============================================================================

/**
 * Interface for process executor functionality.
 * Used for structural typing with bindService.
 */
export interface ProcessExecutorContract {
  createSignal<
    TIdentity extends readonly unknown[] = [],
    TPayload = void,
    TName extends string = string,
  >(name: TName, identityParams?: string[]): Signal<TIdentity, TPayload, TName>

  emit(
    signal: string,
    identity: Record<string, string>,
    payload?: unknown
  ): Promise<number>

  // Deliver an externally-fired timer (e.g. from a ScheduledTask transport
  // adapter) into this executor's internal dispatch path. Without this hook
  // a controller would have to talk to the executor's private timer
  // scheduler directly; exposing receiveTimerFire on the contract keeps
  // that adapter against `AbstractProcessExecutor`, not an impl detail.
  receiveTimerFire(fired: TimerFired): void
}

/**
 * Abstract ProcessExecutor for dependency injection.
 *
 * Inject this into services to create signals bound to the executor:
 *
 * @example
 * ```typescript
 * const OrderSignals = defineService({
 *   inject: { executor: AbstractProcessExecutor },
 *   factory: ({ executor }) => ({
 *     shipped: executor.createSignal<[orderId: string]>('orders.shipped', ['orderId']),
 *   })
 * })
 * ```
 */
export abstract class AbstractProcessExecutor extends defineAbstract<ProcessExecutorContract>('AbstractProcessExecutor') {}

// ============================================================================
// Process Executor
// ============================================================================

/**
 * Executes durable processes using switch-based execution model.
 *
 * Features:
 * - VM-style switch execution with suspension/resumption
 * - Signal routing via SignalBus
 * - Timer scheduling via TimerScheduler
 * - State persistence via ProcessStorage
 */
export class ProcessExecutor extends AbstractProcessExecutor {
  private readonly container: Container | null;
  private readonly resolve: Resolver;
  private readonly storage: ProcessStorage;
  private readonly signalBus: SignalBus;
  private readonly timerScheduler: TimerScheduler;
  private readonly lockProvider: LockProvider | null;

  // Unique identifier for this executor instance (for lock ownership)
  private readonly executorId = `exec_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // In-memory completion promises (not persisted)
  private completions = new Map<string, Deferred<unknown>>();

  // Cache resolved services per process definition
  private resolvedServicesCache = new Map<string, Record<string, unknown>>();

  // Active subscriptions by instance ID (for cleanup)
  private subscriptions = new Map<string, string[]>();

  // Registry of process definitions by ID (for resume)
  private processRegistry = new Map<string, CompiledSwitchProcess<Record<string, ServiceToken>>>();

  // Origin request context by instance ID (for tracing)
  private originContexts = new Map<string, { type: string; name: string; id: string }>();

  // Yield queues for generator processes (live consumers)
  private yieldQueues = new Map<string, YieldQueue>();

  // Live handle registry: executor pushes exports + status into active handles
  private handles = new Map<string, ProcessHandleImpl<unknown, unknown>>();

  // Lock options for process execution
  private readonly lockOptions = {
    ttl: 60_000,      // 60s TTL
    timeout: 30_000,  // 30s wait for acquisition
    key: '',          // Set per-lock
    heartbeat: false,
    heartbeatInterval: 20_000,
  };

  private readonly publishExports: ((payload: ExportsPublishPayload) => Promise<void>) | null;

  constructor(options: ProcessExecutorOptions) {
    super();
    this.container = options.container ?? null;
    this.resolve = options.resolve;
    this.storage = options.storage;
    this.signalBus = options.signalBus;
    this.timerScheduler = options.timerScheduler;
    this.lockProvider = options.lockProvider ?? null;
    this.publishExports = options.publishExports ?? null;

    // Listen for signal matches
    // Signal bus handles re-entrancy via processingInstances tracking and queuing.
    // We must await handleSignalMatch so that emit() callers can await process completion.
    this.signalBus.onMatch(async match => {
      await this.handleSignalMatch(match);
    });

    // Listen for timer fires
    // Timers can use setImmediate since they're fire-and-forget (no caller awaits)
    this.timerScheduler.onFire(fired => {
      setImmediate(() => this.handleTimerFired(fired));
    });
  }

  /**
   * Register a process definition for resumption after signals.
   */
  register(process: CompiledSwitchProcess<Record<string, ServiceToken>>): void {
    this.processRegistry.set(process.id, process);
  }

  /**
   * Start or resume a process.
   */
  async start<TResult>(
    process: CompiledSwitchProcess<Record<string, ServiceToken>>,
    params: readonly unknown[]
  ): Promise<ProcessHandle<TResult>> {
    trace('start', { processId: process.id, params });
    // Register process for resumption
    this.register(process);

    const instanceId = generateInstanceId(process.path, params);
    trace('instanceId', { instanceId });
    const resolvedPath = resolvePath(process.path, params);
    const identity = extractIdentity(process.path, params);

    // Acquire process lock before checking/creating state
    const lockKey = `process:${instanceId}`;
    trace('start.acquiringLock', { instanceId });
    await this.acquireLock(lockKey);
    trace('start.lockAcquired', { instanceId });

    try {
      // Check for existing process
      const existing = await this.storage.load(instanceId);
      trace('start.existingCheck', { instanceId, exists: !!existing, status: existing?.status });

      // rt-3: if the existing instance is cancelled, discard it and start fresh
      if (existing && existing.status === 'cancelled') {
        trace('start.cancelledRestart', { instanceId });
        await this.storage.delete(instanceId);
        // Remove stale completion/handle so fresh ones are created below
        this.completions.delete(instanceId);
        this.handles.delete(instanceId);
      } else if (existing) {
        let completion = this.completions.get(instanceId) as Deferred<TResult> | undefined;
        if (!completion) {
          const newCompletion = createDeferred<TResult>();
          this.completions.set(instanceId, newCompletion as Deferred<unknown>);
          completion = newCompletion;

          if (existing.status === 'completed') {
            newCompletion.resolve(existing.result as TResult);
          } else if (existing.status === 'failed') {
            newCompletion.reject(new Error(existing.error ?? 'Process failed'));
          }
        }

        // Release lock if process already completed/failed (no execution needed)
        if (existing.status === 'completed' || existing.status === 'failed') {
          await this.releaseLock(lockKey);
        } else if (existing.status === 'suspended') {
          // Re-subscribe to signals for suspended process (in-memory signal bus doesn't persist)
          trace('start.resubscribing', { instanceId });
          await this.resubscribeSuspended(existing, identity, process.types);
          trace('start.releasingLock', { instanceId });
          await this.releaseLock(lockKey);
          trace('start.lockReleased', { instanceId });
        }

        const handle = new ProcessHandleImpl<TResult>(
          instanceId,
          resolvedPath,
          () => this.loadState(instanceId),
          completion,
          (id) => this.cancel(id),
          process.exports,
        );
        handle.updateStatus(existing.status as ProcessStatus);
        this.handles.set(instanceId, handle as ProcessHandleImpl<unknown, unknown>);

        // Populate handle with exports from stored state (deserialize first)
        if (process.exports && existing.variables?.exports) {
          const deserialized = deserializeState(
            { exports: existing.variables.exports } as Record<string, unknown>
          );
          if (deserialized.exports) {
            handle.setExportsData(
              this.buildFrozenExports(
                deserialized.exports as Record<string, unknown>,
                process.exports,
              )
            );
          }
        }

        return handle;
      }

      // Create new process state
      const state: SwitchProcessState = {
        processId: process.id,
        instanceId,
        version: process.version,
        step: 0,
        persistedStep: Object.entries(process.stepMap).find(([_, v]) => v === 0)?.[0] ?? 'entry',
        vars: {
          __identity: identity,
          __params: params,
          ...identity,
        },
        timers: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'pending',
      };

      await this.saveState(state);

      const completion = createDeferred<TResult>();
      this.completions.set(instanceId, completion as Deferred<unknown>);

      // Capture origin request context for tracing
      const originCtx = getRequestContext();
      if (originCtx) {
        this.originContexts.set(instanceId, {
          type: originCtx.type,
          name: originCtx.name,
          id: originCtx.id,
        });
      }

      const handle = new ProcessHandleImpl<TResult>(
        instanceId,
        resolvedPath,
        () => this.loadState(instanceId),
        completion,
        (id) => this.cancel(id),
        process.exports,
      );
      this.handles.set(instanceId, handle as ProcessHandleImpl<unknown, unknown>);

      // Start execution (lock released in suspend/complete/fail).
      // saveState inside execute() pushes exports and status into the handle.
      await this.execute(state, process, identity);

      return handle;
    } catch (err) {
      // Release lock on error
      await this.releaseLock(lockKey);
      throw err;
    }
  }

  /**
   * Emit a signal to waiting processes.
   *
   * Lock acquisition happens in handleSignalMatch() when the signal is delivered.
   * This avoids deadlock since handleSignalMatch() is called synchronously from emit().
   */
  async emit(
    signal: string,
    identity: Record<string, string>,
    payload?: unknown
  ): Promise<number> {
    // Encode Processable payloads so they survive JSONB round-trips
    const encoded = encodeProcessable(payload);
    return this.signalBus.emit(signal, identity, encoded);
  }

  /**
   * Create a signal bound to this executor.
   *
   * The returned signal is callable directly and will emit through this executor,
   * which handles locking to prevent dead letters.
   *
   * @param name - Signal name for routing (e.g., 'orders.shipped')
   * @param identityParams - Names of identity parameters (e.g., ['orderId'])
   *
   * @example
   * ```typescript
   * const OrderSignals = defineService({
   *   inject: { executor: ProcessExecutor },
   *   factory: ({ executor }) => ({
   *     shipped: executor.createSignal<[orderId: string], { trackingNumber: string }>(
   *       'orders.shipped',
   *       ['orderId']
   *     ),
   *   })
   * })
   *
   * // Usage: await orderSignals.shipped('order-123', { trackingNumber: 'ABC' })
   * ```
   */
  createSignal<
    TIdentity extends readonly unknown[] = [],
    TPayload = void,
    TName extends string = string,
  >(name: TName, identityParams: string[] = []): Signal<TIdentity, TPayload, TName> {
    const executor = this;

    const signal = async (...args: unknown[]): Promise<void> => {
      trace('signal.invoke', { name, args: args.slice(0, identityParams.length) });
      // Build identity record from args and param names
      const identity: Record<string, string> = {};
      for (let i = 0; i < identityParams.length && i < args.length; i++) {
        identity[identityParams[i]] = String(args[i]);
      }

      // Payload is the last arg if there are more args than identity params
      const payload = args.length > identityParams.length
        ? args[identityParams.length]
        : undefined;

      trace('signal.emit', { name, identity, hasPayload: payload !== undefined });
      await executor.emit(name, identity, payload);
      trace('signal.emit.complete', { name });
    };

    // Add brand and metadata
    Object.defineProperty(signal, SIGNAL_BRAND, { value: SIGNAL_BRAND });
    Object.defineProperty(signal, 'signalName', { value: name });
    Object.defineProperty(signal, '__identityParams', { value: identityParams });

    // PromiseLike support - allows `await signal` in process handlers
    // At compile time this is transformed; at runtime it throws if used incorrectly
    Object.defineProperty(signal, 'then', {
      value: () => {
        throw new Error(
          `Cannot await signal "${name}" directly. Use signal() inside a process handler.`
        );
      },
    });

    return signal as unknown as Signal<TIdentity, TPayload, TName>;
  }

  // ============================================================================
  // Execution Engine
  // ============================================================================

  /**
   * Execute a switch-based process.
   * Runs within a full request scope for context propagation (if container available).
   */
  private async execute(
    state: SwitchProcessState,
    process: CompiledSwitchProcess<Record<string, ServiceToken>>,
    identity: Record<string, string>
  ): Promise<void> {
    // Inner execution logic
    const executeInner = async () => {
      const services = await this.resolveServices(process);

      try {
        // Get or create yield queue for this instance
        let yieldQueue = this.yieldQueues.get(state.instanceId);
        if (!yieldQueue) {
          yieldQueue = createYieldQueue();
          this.yieldQueues.set(state.instanceId, yieldQueue);
        }

        // Initialize __yields array if not present
        if (!state.vars.__yields) {
          state.vars.__yields = [];
        }

        const yields = state.vars.__yields as unknown[];
        const currentYieldQueue = yieldQueue;

        const ctx: ExecutionContext = {
          state,
          services,
          signalPayload: state.vars.__signalPayload,
          emit: (value: unknown) => {
            yields.push(value);
            currentYieldQueue.push(value);
          },
        };

        // Reattach methods on resume — methods serialize as null in JSONB,
        // so we restore them from exports.methods before executing
        if (state.step > 0 && process.exports && state.vars.exports) {
          const exportsObj = state.vars.exports as Record<string, unknown>;
          for (const [name, fn] of Object.entries(process.exports.methods)) {
            exportsObj[name] = fn;
          }
        }

        // Re-apply types config on every execution (including resume).
        // References don't survive serialization, so we re-wrap from the
        // persisted string identity on each run.
        if (process.types) {
          const typed = applyTypesConfig(identity, process.types);
          for (const [key, value] of Object.entries(typed)) {
            state.vars[key] = value;
          }
        }

        state.status = 'running';
        // Clear recoverable-error marker optimistically — if the handler
        // throws DoubleLockError again it'll be re-stamped in the catch.
        state.lastError = undefined;
        state.lastErrorAt = undefined;
        trace('execute.beforeExecute', { instanceId: state.instanceId, step: state.step, varsKeys: Object.keys(state.vars) });
        const result = await process.execute(ctx);
        trace('execute.afterExecute', { instanceId: state.instanceId, resultType: result[0], resultPayload: (() => { try { return JSON.stringify(result[1], (_k, v) => typeof v === 'bigint' ? `${v}n` : v)?.slice(0, 200); } catch { return String(result[1]); } })() });

        // result is [type, payload]
        if (result[0] === 1) {
          // SUSPEND
          await this.suspend(state, process, result[1] as SuspendConfig, identity);
        } else if (result[0] === 2) {
          // SUBPROCESS — spawn a subprocess and run it within parent's context
          const spawnConfig = result[1] as { name: string; args: unknown[]; storeVar?: string; awaited?: boolean };
          await this.spawnSubprocess(state, process, spawnConfig, identity);
        } else {
          // DONE
          await this.complete(state, result[1]);
        }
      } catch (error) {
        trace('execute.error', { instanceId: state.instanceId, error: error instanceof Error ? error.message : String(error) });
        if (error instanceof DoubleLockError) {
          // Step acquired a lock it already held in this async context.
          // `using lock = await repo.lock(...)` always runs BEFORE mutations,
          // so no side effects occurred. Keep the process SUSPENDED at its
          // prior step so a future execution (next firing, or post-deploy
          // restart) can retry against updated code. Terminating the process
          // with `fail()` would destroy weeks-old durable state because of a
          // bug that might land in the very next PR.
          error.message += ` (process ${process.id}/${state.instanceId} step ${state.step})`;
          console.error(`[ProcessExecutor] ${error.message}`);

          state.lastError = error.message;
          state.lastErrorAt = new Date();
          state.status = 'suspended';

          // Re-register prior subscriptions so the next firing re-triggers
          // execute. Cleanup existing tracked subs first to avoid leaks.
          this.cleanupSubscriptions(state.instanceId);
          const priorRace = state.vars.__raceBranches as SuspendRaceBranch[] | undefined;
          if (priorRace) {
            await this.suspend(state, process, { race: priorRace }, identity);
          } else {
            // First-run failure or non-race suspend point — just persist
            // suspended state. Post-deploy re-hydration will retry.
            await this.saveState(state, process);
          }
          return;
        }
        await this.fail(state, error instanceof Error ? error : new Error(String(error)));
      }
    };

    // Wrap in lock tracking so acquire() can detect re-entrant locks within
    // the same async context. Each execution (fresh + resume) gets its own
    // tracking set.
    const tracked = () => runWithLockTracking(executeInner);

    // If container is available, run in request scope for context propagation
    if (this.container) {
      // Get origin context for tracing (if this process was started from a request)
      const originCtx = this.originContexts.get(state.instanceId);

      await runInFullRequestScope(
        {
          container: this.container,
          type: 'process',
          name: `process:${process.id}/${state.instanceId}`,
          metadata: {
            'process.id': process.id,
            'process.instanceId': state.instanceId,
            'process.step': state.step,
            // Include origin context for tracing
            ...(originCtx && {
              'origin.type': originCtx.type,
              'origin.name': originCtx.name,
              'origin.id': originCtx.id,
            }),
          },
        },
        tracked
      );
    } else {
      // No container - just run directly
      await tracked();
    }
  }

  /**
   * Handle process suspension.
   */
  private async suspend(
    state: SwitchProcessState,
    process: CompiledSwitchProcess<Record<string, ServiceToken>>,
    config: SuspendConfig,
    identity: Record<string, string>
  ): Promise<void> {
    trace('suspend', { instanceId: state.instanceId, config });
    state.status = 'suspended';
    state.suspendedAt = new Date();
    state.persistedStep = Object.entries(process.stepMap)
      .find(([_, v]) => v === state.step)?.[0] ?? String(state.step);

    if ('race' in config) {
      // Race - subscribe to all branches
      const branches = config.race.map(branch => {
        let signalName = branch.signal;
        let isStream = false;

        // Resolve stream wildcards: stream:ModelName:*:fieldName -> stream:ModelName:entityId:fieldName
        // The * placeholder is set by the compiler and resolved here using process identity
        if (signalName?.startsWith('stream:')) {
          isStream = true;
          if (signalName.includes(':*:')) {
            signalName = this.resolveStreamWildcard(signalName, identity, process.types);
          }
        }

        return {
          branchId: branch.id,
          signal: signalName,
          // Stream signals encode the entity ID in the signal name itself,
          // so the identity map is redundant. Using it as a subscription filter
          // breaks when publisher/subscriber use different key conventions
          // (e.g. publisher emits { roomRef: id }, subscriber has { room: id }).
          identity: signalName ? (isStream ? {} : identity) : undefined,
          expiresAt: branch.timer ? this.calculateExpiry(branch.timer) : undefined,
        };
      });
      const subscriptionId = await this.signalBus.subscribeRace(state.instanceId, branches);
      this.trackSubscription(state.instanceId, subscriptionId);

      // Store race branches in state for resume
      state.vars.__raceBranches = config.race;

      // Schedule timers
      for (const branch of config.race) {
        if (branch.timer) {
          const expiresAt = this.calculateExpiry(branch.timer);
          const timerId = await this.timerScheduler.schedule(
            state.instanceId,
            expiresAt,
            branch.id
          );
          this.trackSubscription(state.instanceId, timerId);
        }
      }
    } else if ('signal' in config) {
      const subscriptionId = await this.signalBus.subscribe(
        state.instanceId,
        config.signal,
        identity
      );
      this.trackSubscription(state.instanceId, subscriptionId);
      // Persist signal name so resubscribeSuspended can restore it after restart
      state.vars.__suspendSignal = config.signal;
    } else if ('timer' in config) {
      const expiresAt = this.calculateExpiry(config.timer);
      const timerId = await this.timerScheduler.schedule(
        state.instanceId,
        expiresAt,
        '__timer__'
      );
      this.trackSubscription(state.instanceId, timerId);
    } else if ('parallel' in config) {
      // Parallel (signal.all / signal.settled): subscribe each signal branch individually
      const parallel = config.parallel;
      const branchSubs: Array<{ branchIndex: number; subscriptionId: string }> = [];

      for (let i = 0; i < parallel.branches.length; i++) {
        const branch = parallel.branches[i];
        if (branch.type === 'signal' && branch.expr) {
          const signalName = (branch.expr as { signalName?: string }).signalName;
          if (signalName) {
            const subscriptionId = await this.signalBus.subscribe(
              state.instanceId,
              signalName,
              identity
            );
            this.trackSubscription(state.instanceId, subscriptionId);
            branchSubs.push({ branchIndex: i, subscriptionId });
          }
        } else if (branch.type === 'delay') {
          const timerDuration = (branch.expr as { seconds?: number; minutes?: number; hours?: number; days?: number }) ?? {};
          const expiresAt = this.calculateExpiry(timerDuration);
          const timerId = await this.timerScheduler.schedule(
            state.instanceId,
            expiresAt,
            `__parallel_${parallel.parallelId}_${i}`
          );
          this.trackSubscription(state.instanceId, timerId);
          branchSubs.push({ branchIndex: i, subscriptionId: timerId });
        }
      }

      // Store parallel tracking info in state.vars for handleSignalMatch
      state.vars.__parallelBranches = branchSubs.map(bs => ({
        branchIndex: bs.branchIndex,
        subscriptionId: bs.subscriptionId,
        parallelId: parallel.parallelId,
      }));
    } else if ('scope' in config) {
      // Scope suspension: parallel fan-out over entities
      await this.handleScopeSuspend(state, process, config.scope, identity);

      // Empty scope: handleScopeSuspend sets status='running' and advances the step.
      // Re-execute instead of suspending.
      if ((state.status as string) === 'running') {
        await this.saveState(state, process);
        await this.execute(state, process, identity);
        return;
      }
    }

    await this.saveState(state, process);

    // Release lock AFTER subscriptions are registered
    // This ensures signals wait for subscription before being delivered
    await this.releaseLock(`process:${state.instanceId}`);
  }

  /**
   * Re-subscribe a suspended process to its signals.
   * Called when loading a suspended process from storage, since in-memory
   * signal bus doesn't persist subscriptions across restarts.
   */
  private async resubscribeSuspended(
    state: { instanceId: string; variables: Record<string, unknown> },
    identity: Record<string, string>,
    types?: Record<string, unknown>,
  ): Promise<void> {
    // Check if this process has already been re-subscribed
    if (this.subscriptions.has(state.instanceId)) {
      return;
    }

    const raceBranches = state.variables.__raceBranches as SuspendRaceBranch[] | undefined;
    const suspendSignal = state.variables.__suspendSignal as string | undefined;

    if (raceBranches) {
      // Re-subscribe to race branches
      const branches = raceBranches.map(branch => {
        let signalName = branch.signal;
        let isStream = false;

        // Resolve stream wildcards (same as in suspend)
        if (signalName?.startsWith('stream:')) {
          isStream = true;
          if (signalName.includes(':*:')) {
            signalName = this.resolveStreamWildcard(signalName, identity, types);
          }
        }

        return {
          branchId: branch.id,
          signal: signalName,
          identity: signalName ? (isStream ? {} : identity) : undefined,
          expiresAt: branch.timer ? this.calculateExpiry(branch.timer) : undefined,
        };
      });
      const subscriptionId = await this.signalBus.subscribeRace(state.instanceId, branches);
      this.trackSubscription(state.instanceId, subscriptionId);

      // Schedule timers for any timer branches
      for (const branch of raceBranches) {
        if (branch.timer) {
          const expiresAt = this.calculateExpiry(branch.timer);
          const timerId = await this.timerScheduler.schedule(
            state.instanceId,
            expiresAt,
            branch.id
          );
          this.trackSubscription(state.instanceId, timerId);
        }
      }
    } else if (suspendSignal) {
      // Re-subscribe to plain signal suspension (await signal(x))
      const subscriptionId = await this.signalBus.subscribe(
        state.instanceId,
        suspendSignal,
        identity
      );
      this.trackSubscription(state.instanceId, subscriptionId);
    }
  }

  // ============================================================================
  // Signal & Timer Handling
  // ============================================================================

  private async handleSignalMatch(match: SignalMatch): Promise<void> {
    trace('handleSignalMatch', { instanceId: match.instanceId, branchId: match.branchId });

    // Subprocess instanceIds carry an `/__sub:...` suffix — route those to
    // the child-resume path, which loads the parent row and resumes the
    // nested child state in place.
    if (match.instanceId.includes('/__sub:')) {
      await this.resumeChild(match);
      return;
    }

    // Check if this subscription belongs to this executor instance.
    // In multi-instance scenarios, all executors receive the same NOTIFY via Postgres,
    // but only the executor that registered the subscription should process it.
    const trackedSubs = this.subscriptions.get(match.instanceId);
    if (!trackedSubs || !trackedSubs.includes(match.subscriptionId)) {
      trace('handleSignalMatch.skipped', { instanceId: match.instanceId, reason: 'subscription not owned by this executor' });
      return; // This subscription was registered by a different executor instance
    }

    // Acquire lock before resuming process.
    // By design, the lock is always available: the process is suspended (nobody holds it).
    // If this fails, something is fundamentally wrong — propagate the error.
    const lockKey = `process:${match.instanceId}`;
    await this.acquireLock(lockKey);
    trace('handleSignalMatch.lockAcquired', { instanceId: match.instanceId });

    try {
      // Note: Don't cleanup subscriptions here - do it after execute
      // This prevents race conditions when multiple signals arrive quickly

      const state = await this.loadState(match.instanceId);
      trace('handleSignalMatch.stateLoaded', { instanceId: match.instanceId, status: state?.status });
      if (!state) {
        trace('handleSignalMatch.noState', { instanceId: match.instanceId });
        await this.releaseLock(lockKey);
        return;
      }

      if (state.status !== 'suspended') {
        trace('handleSignalMatch.notSuspended', { instanceId: match.instanceId, status: state.status });
        await this.releaseLock(lockKey);
        return;
      }

      // Find the process definition
      const process = this.processRegistry.get(state.processId);
      if (!process) {
        trace('handleSignalMatch.noProcess', { processId: state.processId });
        await this.releaseLock(lockKey);
        return;
      }
      trace('handleSignalMatch.processFound', { processId: state.processId });

      // Check for parallel branch subscription
      const parallelBranches = state.vars.__parallelBranches as Array<{ branchIndex: number; subscriptionId: string; parallelId: number }> | undefined;

      if (parallelBranches) {
        // Check if this subscription matches a parallel branch
        const parallelBranch = parallelBranches.find(pb => pb.subscriptionId === match.subscriptionId);

        if (parallelBranch) {
          // This is a parallel branch signal - update parallel state in state.vars
          const parallelVarName = `__parallel_${parallelBranch.parallelId}`;
          const parallelState = state.vars[parallelVarName] as {
            pending: number; results: unknown[]; errors: unknown[]; isSettled: boolean
          } | undefined;

          if (parallelState) {
            parallelState.results[parallelBranch.branchIndex] = decodeProcessable(match.payload);
            parallelState.pending--;
            trace('handleSignalMatch.parallelBranch', {
              parallelId: parallelBranch.parallelId,
              branchIndex: parallelBranch.branchIndex,
              pending: parallelState.pending,
            });

            // Remove this subscription from tracking
            this.untrackSubscription(match.instanceId, match.subscriptionId);

            if (parallelState.pending > 0) {
              // Not all branches done - save state and release lock, don't resume
              await this.saveState(state, process);
              await this.releaseLock(lockKey);
              return;
            }

            // All branches completed - clean up parallel tracking and resume
            delete state.vars.__parallelBranches;

            // Get identity from state
            const identity = state.vars.__identity as Record<string, string>;

            // Snapshot remaining subscriptions for cleanup
            const oldSubs = [...(this.subscriptions.get(match.instanceId) ?? [])];

            state.status = 'running';
            trace('handleSignalMatch.parallelComplete', { instanceId: match.instanceId, step: state.step });
            await this.execute(state, process, identity);
            trace('handleSignalMatch.executeComplete', { instanceId: match.instanceId });

            // Cleanup remaining subscriptions
            for (const subId of oldSubs) {
              this.signalBus.unsubscribe(subId);
              this.timerScheduler.cancel(subId);
              this.untrackSubscription(match.instanceId, subId);
            }
            return;
          }
        }
      }

      // Handle race vs simple signal
      if (match.branchId) {
        // Race result - find the winning branch and set step to its resumeStep
        const branches = state.vars.__raceBranches as SuspendRaceBranch[] | undefined;
        trace('handleSignalMatch.raceBranches', { branchId: match.branchId, hasBranches: !!branches, branchCount: branches?.length });
        if (branches) {
          const branch = branches.find(b => b.id === match.branchId);
          if (branch) {
            state.step = branch.resumeStep;
            // Stream branches expect { value: T }, signals expect T directly
            // The branch ID for streams starts with "stream:"
            if (match.branchId.startsWith('stream:')) {
              state.vars.__raceResult = { value: decodeProcessable(match.payload) };
            } else {
              state.vars.__raceResult = decodeProcessable(match.payload);
            }
            delete state.vars.__raceBranches;
            trace('handleSignalMatch.branchFound', { branchId: match.branchId, resumeStep: branch.resumeStep });
          } else {
            trace('handleSignalMatch.branchNotFound', { branchId: match.branchId, availableBranches: branches.map(b => b.id) });
          }
        }
      } else {
        // Simple signal - payload goes into signalPayload for the execute context
        state.vars.__signalPayload = decodeProcessable(match.payload);
        delete state.vars.__suspendSignal;
      }

      // Get identity from state
      const identity = state.vars.__identity as Record<string, string>;

      // Snapshot all OLD subscriptions before re-executing.
      // A race registers both signal subscriptions and timers under different IDs.
      // When one branch wins, ALL losing branches must be cancelled — not just the matched one.
      const oldSubs = [...(this.subscriptions.get(match.instanceId) ?? [])];

      // Resume execution (lock released in suspend/complete/fail)
      trace('handleSignalMatch.execute', { instanceId: match.instanceId, step: state.step });
      await this.execute(state, process, identity);
      trace('handleSignalMatch.executeComplete', { instanceId: match.instanceId });

      // Cleanup ALL old subscriptions (signals + timers from the previous suspend).
      // The process has now re-suspended with NEW subscriptions (different IDs)
      // or completed (which already called cleanupSubscriptions).
      for (const subId of oldSubs) {
        this.signalBus.unsubscribe(subId);
        this.timerScheduler.cancel(subId);
        this.untrackSubscription(match.instanceId, subId);
      }
    } catch (err) {
      // Release lock on error
      await this.releaseLock(lockKey);
      throw err;
    }
  }

  private async handleTimerFired(fired: TimerFired): Promise<void> {
    // Timer fired - treat as signal match with void payload
    const match: SignalMatch = {
      subscriptionId: fired.timerId,
      instanceId: fired.instanceId,
      payload: undefined,
      branchId: fired.branchId,
    };
    await this.handleSignalMatch(match);
  }

  // External entry point for adapters that source timer fires outside the
  // bound timerScheduler (e.g. ScheduledTask delivery via HTTP/WS). Mirrors
  // the internal onFire path: setImmediate so we don't run the dispatch
  // synchronously inside the caller's stack, then route into the same
  // private handler. handleSignalMatch absorbs unknown subscriptions, so a
  // stale fire after subscribe-then-cancel is harmless.
  receiveTimerFire(fired: TimerFired): void {
    setImmediate(() => {
      this.handleTimerFired(fired).catch(err => {
        trace('receiveTimerFire dispatch error', { err: String(err) });
      });
    });
  }

  // ============================================================================
  // Scope Handling (parallel fan-out)
  // ============================================================================

  /**
   * Handle scope suspension: fan-out over entities.
   *
   * For signal-first form: subscribe to the signal for each entity's identity.
   * For handler form: spawn sub-processes for each entity.
   *
   * When all entities complete, resume the parent process at resumeStep.
   */
  private async handleScopeSuspend(
    state: SwitchProcessState,
    process: CompiledSwitchProcess<Record<string, ServiceToken>>,
    scopeConfig: { scopeId: number; type: 'signal' | 'handler'; signal?: unknown; resumeStep: number },
    identity: Record<string, string>
  ): Promise<void> {
    const { scopeId, resumeStep } = scopeConfig;
    const entities = state.vars[`__scope_${scopeId}_entities`] as unknown[];
    const idFn = state.vars[`__scope_${scopeId}_idFn`] as ((entity: unknown) => string) | undefined;

    if (!entities || entities.length === 0) {
      // No entities — skip suspension, continue to resume step
      state.step = resumeStep;
      state.status = 'running';
      state.vars[`__scope_${scopeId}_results`] = {};
      return;
    }

    // Extract entity IDs
    const entityIds = entities.map((entity, index) => {
      if (idFn) return idFn(entity);
      // Auto-derive ID: if entity has an 'id' property, use it
      if (typeof entity === 'object' && entity !== null && 'id' in entity) {
        return String((entity as { id: unknown }).id);
      }
      return String(index);
    });

    // TSP3008: Check for duplicate entity IDs (runtime check)
    const seen = new Set<string>();
    for (const id of entityIds) {
      if (seen.has(id)) {
        throw new Error(`Duplicate entity ID '${id}' in scope(). Each entity must have a unique identity.`);
      }
      seen.add(id);
    }

    // TSP3006: Check item limit (runtime check)
    if (entities.length > 1000) {
      throw new Error(`scope() exceeded maximum item limit (1000). Got ${entities.length} entities.`);
    }

    // Initialize scope tracking
    state.vars[`__scope_${scopeId}_remaining`] = entities.length;
    state.vars[`__scope_${scopeId}_results`] = {};
    state.vars[`__scope_${scopeId}_entityIds`] = entityIds;
    state.vars[`__scope_${scopeId}_resumeStep`] = resumeStep;

    if (scopeConfig.type === 'signal') {
      // Signal-first form: subscribe to signal for each entity
      // Each entity gets a race-style subscription that resolves independently
      for (let i = 0; i < entityIds.length; i++) {
        const entityId = entityIds[i];
        const entityIdentity = { ...identity, __scopeEntityId: entityId };

        const subscriptionId = await this.signalBus.subscribe(
          state.instanceId,
          String(scopeConfig.signal),
          entityIdentity
        );
        this.trackSubscription(state.instanceId, subscriptionId);
      }

      // Store scope info for signal matching
      state.vars.__scopeActive = scopeId;
    }
    // Handler form would spawn sub-processes here (future: compile handler body)
  }

  /**
   * Notify that a scope entity has completed.
   * Decrements the remaining counter and resumes parent if all done.
   */
  async notifyScopeEntityComplete(
    instanceId: string,
    scopeId: number,
    entityId: string,
    result: unknown
  ): Promise<void> {
    const state = await this.loadState(instanceId);
    if (!state) return;

    const results = state.vars[`__scope_${scopeId}_results`] as Record<string, unknown>;
    results[entityId] = result;

    const remaining = (state.vars[`__scope_${scopeId}_remaining`] as number) - 1;
    state.vars[`__scope_${scopeId}_remaining`] = remaining;

    const process = this.processRegistry.get(state.processId);

    if (remaining === 0) {
      // All entities complete — results already a plain object, resume

      const resumeStep = state.vars[`__scope_${scopeId}_resumeStep`] as number;
      state.step = resumeStep;
      state.status = 'running';

      await this.saveState(state, process);

      // Resume execution
      if (process) {
        const identity = state.vars.__identity as Record<string, string>;
        await this.execute(state, process, identity);
      }
    } else {
      await this.saveState(state, process);
    }
  }

  // ============================================================================
  // State Management
  // ============================================================================

  private async loadState(instanceId: string): Promise<SwitchProcessState | null> {
    const stored = await this.storage.load(instanceId);
    if (!stored) return null;

    // Convert from storage format to SwitchProcessState
    return {
      processId: stored.processId,
      instanceId: stored.instanceId,
      version: stored.version,
      step: stored.pc,
      persistedStep: (stored.variables as Record<string, unknown>).__persistedStep as string ?? 'entry',
      vars: deserializeState(stored.variables as Record<string, unknown>),
      timers: stored.timers,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      suspendedAt: stored.suspendedAt,
      completedAt: stored.completedAt,
      status: stored.status,
      result: stored.result,
      error: stored.error,
      lastError: stored.lastError,
      lastErrorAt: stored.lastErrorAt,
    };
  }

  private async saveState(state: SwitchProcessState, process?: CompiledSwitchProcess<Record<string, ServiceToken>>): Promise<void> {
    // Store persistedStep in vars so it survives round-trip
    state.vars.__persistedStep = state.persistedStep;

    // Convert to storage format
    const serializedVars = serializeState(state.vars);
    await this.storage.save({
      processId: state.processId,
      instanceId: state.instanceId,
      version: state.version,
      pc: state.step,
      variables: serializedVars,
      timers: state.timers,
      createdAt: state.createdAt,
      updatedAt: new Date(),
      suspendedAt: state.suspendedAt,
      completedAt: state.completedAt,
      status: state.status,
      result: state.result,
      error: state.error,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
    });

    const handle = this.handles.get(state.instanceId);
    if (handle) {
      handle.updateStatus(state.status);
    }

    // Broadcast exports if the process has them.
    // Use state.vars.exports (pre-serialization) — serializedVars has Processable-encoded
    // forms (Maps → __$type tags) which aren't useful for subscribers.
    if (process?.exports && state.vars.exports) {
      const exportsData: Record<string, unknown> = {};
      const exportsObj = state.vars.exports as Record<string, unknown>;
      for (const fieldName of process.exports.fields) {
        exportsData[fieldName] = exportsObj[fieldName];
      }
      const frozenSnap = this.buildFrozenExports(exportsObj, process.exports);

      if (handle) {
        handle.setExportsData(frozenSnap);
      }

      // Also publish to external channel backend if wired
      if (this.publishExports) {
        try {
          await this.publishExports({
            instanceId: state.instanceId,
            processId: state.processId,
            exports: exportsData,
          });
        } catch {
          // Don't fail the process if export broadcast fails
          trace('saveState.exportsBroadcastFailed', { instanceId: state.instanceId });
        }
      }
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private async spawnSubprocess(
    state: SwitchProcessState,
    process: CompiledSwitchProcess<Record<string, ServiceToken>>,
    spawnConfig: { name: string; args: unknown[]; storeVar?: string; awaited?: boolean },
    identity: Record<string, string>,
  ): Promise<void> {
    const subDef = process.subprocesses?.find(s => s.name === spawnConfig.name);
    if (!subDef) {
      throw new Error(`Subprocess '${spawnConfig.name}' not found on process '${process.id}'`);
    }

    const awaited = spawnConfig.awaited !== false;

    // Create a unique key for this subprocess instance based on args
    const subKey = `__sub:${spawnConfig.name}:${spawnConfig.args.map(String).join(':')}`;
    const childInstanceId = `${state.instanceId}/${subKey}`;

    // Blob layout under parent.vars[subKey]:
    //   { vars: {...user+signal state...}, step, done, result, raceBranches?, suspendSignal? }
    // User-space child variables live under `.vars` so they never collide with
    // the blob's own metadata. Idempotent: if already-done blob exists and the
    // spawn is awaited, flow the cached result straight into storeVar.
    let blob = state.vars[subKey] as SubBlob | undefined;

    if (blob?.done === true && awaited) {
      if (spawnConfig.storeVar) {
        state.vars[spawnConfig.storeVar] = blob.result;
      }
      await this.saveState(state, process);
      await this.execute(state, process, identity);
      return;
    }

    if (!blob) {
      blob = { vars: {}, step: 0, done: false };
      for (let i = 0; i < subDef.params.length; i++) {
        blob.vars[subDef.params[i]] = spawnConfig.args[i];
      }
      state.vars[subKey] = blob;
    }

    // Build a minimal SwitchProcessState for the child execute function.
    // The child shares the parent's services (same inject map on parent process).
    const childState: SwitchProcessState = {
      processId: `${process.id}/${subKey}`,
      instanceId: childInstanceId,
      version: '0',
      step: blob.step ?? 0,
      persistedStep: String(blob.step ?? 0),
      vars: blob.vars,
      timers: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'running',
    };

    const services = await this.resolveServices(process);
    const childCtx: ExecutionContext = {
      state: childState,
      services,
      emit: () => {},
    };

    // Child signal identity = parent's identity + child's path-param args.
    // Without the child-specific keys, two siblings (alice/bob) would both
    // match emits scoped to one (e.g. signals.childTick(p1, alice) would
    // also wake bob). Merging params lets the bus route per-child.
    const childIdentity = { ...identity };
    for (let i = 0; i < subDef.params.length; i++) {
      childIdentity[subDef.params[i]] = String(spawnConfig.args[i]);
    }

    const childResult = await subDef.execute(childCtx);
    await this.applyChildResult(
      state, process, identity, childIdentity, subKey, childState, childResult, spawnConfig, /* fromSpawn */ true,
    );
  }

  /**
   * Apply a child execute() result — from either the initial spawn or a
   * signal-driven resume. Mutates parent.vars[subKey] for DONE/SUSPEND,
   * resumes the parent on awaited DONE, and manages the parent lock.
   *
   * `fromSpawn=true` means the parent is currently inside its own execute()
   * loop and should resume there for detached outcomes. `fromSpawn=false`
   * means resumeChild called us and the parent was otherwise idle/suspended;
   * detached outcomes just save + release.
   */
  private async applyChildResult(
    state: SwitchProcessState,
    process: CompiledSwitchProcess<Record<string, ServiceToken>>,
    parentIdentity: Record<string, string>,
    childIdentity: Record<string, string>,
    subKey: string,
    childState: SwitchProcessState,
    childResult: readonly [number, unknown],
    spawnConfig: { name: string; args: unknown[]; storeVar?: string; awaited?: boolean },
    fromSpawn: boolean,
  ): Promise<void> {
    const awaited = spawnConfig.awaited !== false;
    const childInstanceId = childState.instanceId;
    const blob = state.vars[subKey] as SubBlob;
    const parentLockKey = `process:${state.instanceId}`;

    if (childResult[0] === 0) {
      // DONE
      blob.done = true;
      blob.result = childResult[1];
      blob.step = childState.step;
      delete blob.raceBranches;
      delete blob.suspendSignal;

      if (awaited) {
        if (spawnConfig.storeVar) {
          state.vars[spawnConfig.storeVar] = childResult[1];
        }
        delete state.vars.__pendingChildAwait;
        state.status = 'running';
        await this.saveState(state, process);
        await this.execute(state, process, parentIdentity);
        return;
      }

      // Detached DONE — refresh the handle ref
      if (spawnConfig.storeVar) {
        state.vars[spawnConfig.storeVar] = { __subRef: true, key: subKey, name: spawnConfig.name, result: childResult[1], done: true };
      }
      await this.saveState(state, process);
      if (fromSpawn) {
        await this.execute(state, process, parentIdentity);
      } else {
        await this.releaseLock(parentLockKey);
      }
      return;
    }

    if (childResult[0] === 2) {
      throw new Error(
        `Subprocess '${spawnConfig.name}' attempted to spawn a nested subprocess; ` +
        'nested subprocesses are not yet implemented.'
      );
    }

    // SUSPEND — register the child's subscriptions under childInstanceId
    const childConfig = childResult[1] as SuspendConfig;
    blob.step = childState.step;
    await this.subscribeChildSuspension(childInstanceId, childConfig, childIdentity, blob);

    if (awaited) {
      state.vars.__pendingChildAwait = { subKey, storeVar: spawnConfig.storeVar };
      state.status = 'suspended';
      state.suspendedAt = new Date();
      await this.saveState(state, process);
      await this.releaseLock(parentLockKey);
      return;
    }

    // Detached SUSPEND — parent continues / stays as-is
    if (spawnConfig.storeVar) {
      state.vars[spawnConfig.storeVar] = { __subRef: true, key: subKey, name: spawnConfig.name, done: false };
    }
    await this.saveState(state, process);
    if (fromSpawn) {
      await this.execute(state, process, parentIdentity);
    } else {
      await this.releaseLock(parentLockKey);
    }
  }

  private async subscribeChildSuspension(
    childInstanceId: string,
    config: SuspendConfig,
    identity: Record<string, string>,
    blob: SubBlob,
  ): Promise<void> {
    if ('race' in config) {
      const branches = config.race.map(branch => {
        let signalName = branch.signal;
        let isStream = false;
        if (signalName?.startsWith('stream:')) {
          isStream = true;
          if (signalName.includes(':*:')) {
            signalName = this.resolveStreamWildcard(signalName, identity);
          }
        }
        return {
          branchId: branch.id,
          signal: signalName,
          identity: signalName ? (isStream ? {} : identity) : undefined,
          expiresAt: branch.timer ? this.calculateExpiry(branch.timer) : undefined,
        };
      });
      const subscriptionId = await this.signalBus.subscribeRace(childInstanceId, branches);
      this.trackSubscription(childInstanceId, subscriptionId);
      blob.raceBranches = config.race;

      for (const branch of config.race) {
        if (branch.timer) {
          const expiresAt = this.calculateExpiry(branch.timer);
          const timerId = await this.timerScheduler.schedule(
            childInstanceId,
            expiresAt,
            branch.id
          );
          this.trackSubscription(childInstanceId, timerId);
        }
      }
    } else if ('signal' in config) {
      const subscriptionId = await this.signalBus.subscribe(
        childInstanceId,
        config.signal,
        identity
      );
      this.trackSubscription(childInstanceId, subscriptionId);
      blob.suspendSignal = config.signal;
    } else if ('timer' in config) {
      const expiresAt = this.calculateExpiry(config.timer);
      const timerId = await this.timerScheduler.schedule(
        childInstanceId,
        expiresAt,
        '__timer__'
      );
      this.trackSubscription(childInstanceId, timerId);
    } else {
      throw new Error(
        'Subprocess suspended with unsupported config shape ' +
        '(scope/parallel inside subprocesses is not yet implemented).'
      );
    }
  }

  /**
   * Resume a child process after one of its signal subscriptions fired.
   * The child's instanceId encodes its scope as `${parentInstanceId}/__sub:name:args`.
   * We load the parent row, extract the child's nested state, apply the signal
   * match, and re-enter child.execute(). On child DONE, applyChildResult
   * resumes the parent if the parent was awaiting.
   */
  private async resumeChild(match: SignalMatch): Promise<void> {
    const { parentInstanceId, subKey } = parseChildInstanceId(match.instanceId);
    if (!parentInstanceId || !subKey) {
      trace('resumeChild.invalidInstanceId', { instanceId: match.instanceId });
      return;
    }

    const trackedSubs = this.subscriptions.get(match.instanceId);
    if (!trackedSubs || !trackedSubs.includes(match.subscriptionId)) {
      trace('resumeChild.notOwned', { instanceId: match.instanceId });
      return;
    }

    const parentLockKey = `process:${parentInstanceId}`;
    await this.acquireLock(parentLockKey);
    try {
      const parentState = await this.loadState(parentInstanceId);
      if (!parentState) {
        trace('resumeChild.noParent', { parentInstanceId });
        await this.releaseLock(parentLockKey);
        return;
      }

      const blob = parentState.vars[subKey] as SubBlob | undefined;
      if (!blob) {
        trace('resumeChild.noChildBlob', { parentInstanceId, subKey });
        await this.releaseLock(parentLockKey);
        return;
      }

      const process = this.processRegistry.get(parentState.processId);
      if (!process) {
        trace('resumeChild.noProcess', { processId: parentState.processId });
        await this.releaseLock(parentLockKey);
        return;
      }

      const subName = subKey.split(':')[1];
      const subDef = process.subprocesses?.find(s => s.name === subName);
      if (!subDef) {
        trace('resumeChild.noSubDef', { subName });
        await this.releaseLock(parentLockKey);
        return;
      }

      // Apply the signal match to the child's blob — mirrors handleSignalMatch
      // race/simple-signal dispatch but on the nested blob.
      if (match.branchId) {
        const branches = blob.raceBranches;
        if (branches) {
          const branch = branches.find(b => b.id === match.branchId);
          if (branch) {
            blob.step = branch.resumeStep;
            if (match.branchId.startsWith('stream:')) {
              blob.vars.__raceResult = { value: decodeProcessable(match.payload) };
            } else {
              blob.vars.__raceResult = decodeProcessable(match.payload);
            }
            delete blob.raceBranches;
          }
        }
      } else {
        blob.vars.__signalPayload = decodeProcessable(match.payload);
        delete blob.suspendSignal;
      }

      const childState: SwitchProcessState = {
        processId: `${process.id}/${subKey}`,
        instanceId: match.instanceId,
        version: '0',
        step: blob.step ?? 0,
        persistedStep: String(blob.step ?? 0),
        vars: blob.vars,
        timers: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'running',
      };

      const services = await this.resolveServices(process);
      const childCtx: ExecutionContext = { state: childState, services, emit: () => {} };

      const oldSubs = [...(this.subscriptions.get(match.instanceId) ?? [])];

      const childResult = await subDef.execute(childCtx);

      // Reconstruct spawnConfig from __pendingChildAwait so applyChildResult
      // knows the awaited/storeVar context. For detached, neither is set.
      const pendingAwait = parentState.vars.__pendingChildAwait as
        | { subKey: string; storeVar?: string }
        | undefined;
      const spawnConfig = {
        name: subName,
        args: subDef.params.map(p => blob.vars[p]),
        storeVar: pendingAwait?.subKey === subKey ? pendingAwait.storeVar : undefined,
        awaited: pendingAwait?.subKey === subKey,
      };
      const parentIdentity = (parentState.vars.__identity as Record<string, string>) ?? {};
      const childIdentity = { ...parentIdentity };
      for (const p of subDef.params) {
        childIdentity[p] = String(blob.vars[p]);
      }

      await this.applyChildResult(
        parentState, process, parentIdentity, childIdentity, subKey, childState, childResult, spawnConfig, /* fromSpawn */ false,
      );

      for (const subId of oldSubs) {
        this.signalBus.unsubscribe(subId);
        this.timerScheduler.cancel(subId);
        this.untrackSubscription(match.instanceId, subId);
      }
    } catch (err) {
      await this.releaseLock(parentLockKey);
      throw err;
    }
  }

  private buildFrozenExports(
    exportsObj: Record<string, unknown>,
    metadata: ProcessExportsMetadata,
  ): unknown {
    const data: Record<string, unknown> = {};
    for (const fieldName of metadata.fields) {
      data[fieldName] = exportsObj[fieldName];
    }
    return freezeExports(data, metadata.methods);
  }

  private async resolveServices(
    process: CompiledSwitchProcess<Record<string, ServiceToken>>
  ): Promise<Record<string, unknown>> {
    const cached = this.resolvedServicesCache.get(process.id);
    if (cached) return cached;

    const resolved: Record<string, unknown> = {};
    for (const [key, token] of Object.entries(process.inject)) {
      resolved[key] = await this.resolve(token);
    }

    this.resolvedServicesCache.set(process.id, resolved);
    return resolved;
  }

  private calculateExpiry(timer: {
    days?: number
    hours?: number
    minutes?: number
    seconds?: number
  }): Date {
    const ms =
      (timer.days ?? 0) * 24 * 60 * 60 * 1000 +
      (timer.hours ?? 0) * 60 * 60 * 1000 +
      (timer.minutes ?? 0) * 60 * 1000 +
      (timer.seconds ?? 0) * 1000;
    return new Date(Date.now() + ms);
  }

  /**
   * Resolve stream signal wildcard to actual entity ID.
   *
   * Stream signals from the compiler have format: stream:ModelName:*:fieldName
   * The * needs to be resolved using the process identity at runtime.
   *
   * Uses the shared stream-utils for proper camelCase conversion that handles:
   * - Standard models: Order → orderId
   * - Acronyms: ABC → abcId, HTTPServer → httpServerId
   * - Numbers: V2Order → v2OrderId
   *
   * @example
   * Input: stream:Order:*:statusUpdates, identity: { orderId: 'abc123' }
   * Output: stream:Order:abc123:statusUpdates
   */
  private resolveStreamWildcard(
    signalName: string,
    identity: Record<string, string>,
    types?: Record<string, unknown>,
  ): string {
    const { resolved, result } = resolveStreamWildcardUtil(
      signalName,
      identity,
      types as Record<string, { name?: string }> | undefined,
    );

    if (result.success) {
      if (result.usedFallback) {
        trace('resolveStreamWildcard.fallback', {
          from: signalName,
          to: resolved,
          usedKey: result.usedKey,
        });
      } else {
        trace('resolveStreamWildcard', { from: signalName, to: resolved });
      }
    } else {
      trace('resolveStreamWildcard.failed', { signalName, error: result.error });
      // Log warning to help users debug
      console.warn(`[Stream] Warning: ${result.error}`);
    }

    return resolved;
  }

  private trackSubscription(instanceId: string, subscriptionId: string): void {
    const subs = this.subscriptions.get(instanceId) ?? [];
    subs.push(subscriptionId);
    this.subscriptions.set(instanceId, subs);
  }

  private untrackSubscription(instanceId: string, subscriptionId: string): void {
    const subs = this.subscriptions.get(instanceId);
    if (subs) {
      const idx = subs.indexOf(subscriptionId);
      if (idx !== -1) {
        subs.splice(idx, 1);
      }
      if (subs.length === 0) {
        this.subscriptions.delete(instanceId);
      }
    }
  }

  private cleanupSubscriptions(instanceId: string): void {
    const subs = this.subscriptions.get(instanceId);
    if (subs) {
      for (const subId of subs) {
        this.signalBus.unsubscribe(subId);
        this.timerScheduler.cancel(subId);
      }
      this.subscriptions.delete(instanceId);
    }
  }

  /**
   * Cascade-cancel all live subprocesses of a parent reaching a terminal
   * state. Lexical scope dictates lifetime: children's subscriptions are
   * torn down so they can no longer receive signals and resume. Nested
   * blob stays in parent.vars for post-mortem inspection.
   */
  private cleanupChildSubscriptions(state: SwitchProcessState): void {
    for (const key of Object.keys(state.vars)) {
      if (!key.startsWith('__sub:')) continue;
      const blob = state.vars[key] as SubBlob | undefined;
      if (!blob || blob.done) continue;
      const childInstanceId = `${state.instanceId}/${key}`;
      this.cleanupSubscriptions(childInstanceId);
    }
  }

  /**
   * Acquire a process lock. No-op if no lock provider configured.
   * Blocks until lock is acquired - JustScale locks never fail.
   */
  private async acquireLock(lockKey: string): Promise<void> {
    if (!this.lockProvider) return;

    await this.lockProvider.acquire(
      lockKey,
      { ...this.lockOptions, key: lockKey },
      this.executorId
    );
  }

  /**
   * Release a process lock. No-op if no lock provider configured.
   */
  private async releaseLock(lockKey: string): Promise<void> {
    trace('releaseLock', { lockKey });
    if (!this.lockProvider) return;
    await this.lockProvider.release(lockKey, this.executorId);
    trace('releaseLock.done', { lockKey });
  }

  private async complete(state: SwitchProcessState, result: unknown): Promise<void> {
    state.status = 'completed';
    state.result = result;
    state.completedAt = new Date();

    // Cascade: parent reached terminal state, tear down any live children.
    // Lexical scope dictates lifetime; detached mode is a v1.1 concern.
    this.cleanupChildSubscriptions(state);

    const process = this.processRegistry.get(state.processId);
    await this.saveState(state, process);
    await this.storage.complete(state.instanceId, result);
    this.cleanupSubscriptions(state.instanceId);
    this.originContexts.delete(state.instanceId);
    this.handles.delete(state.instanceId);

    // Signal yield queue completion
    const yieldQueue = this.yieldQueues.get(state.instanceId);
    if (yieldQueue) {
      yieldQueue.complete();
      this.yieldQueues.delete(state.instanceId);
    }

    // Release process lock after completion
    await this.releaseLock(`process:${state.instanceId}`);

    const completion = this.completions.get(state.instanceId);
    if (completion) {
      completion.resolve(result);
      this.completions.delete(state.instanceId);
    }
  }

  private async fail(state: SwitchProcessState, error: Error): Promise<void> {
    state.status = 'failed';
    state.error = error.message;
    state.completedAt = new Date();

    this.cleanupChildSubscriptions(state);

    const process = this.processRegistry.get(state.processId);
    await this.saveState(state, process);
    await this.storage.fail(state.instanceId, error.message);
    this.cleanupSubscriptions(state.instanceId);
    this.originContexts.delete(state.instanceId);
    this.handles.delete(state.instanceId);

    // Signal yield queue completion (consumers see done)
    const yieldQueue = this.yieldQueues.get(state.instanceId);
    if (yieldQueue) {
      yieldQueue.complete();
      this.yieldQueues.delete(state.instanceId);
    }

    // Release process lock after failure
    await this.releaseLock(`process:${state.instanceId}`);

    const completion = this.completions.get(state.instanceId);
    if (completion) {
      completion.reject(error);
      this.completions.delete(state.instanceId);
    }
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Get a process state by instance ID.
   */
  async get(instanceId: string): Promise<SwitchProcessState | null> {
    return this.loadState(instanceId);
  }

  async *queryByStatus(status: ProcessStatus): AsyncIterable<SwitchProcessState> {
    for await (const stored of this.storage.findByStatus(status)) {
      const state = await this.loadState(stored.instanceId);
      if (state) yield state;
    }
  }

  async *queryByProcessId(processId: string): AsyncIterable<SwitchProcessState> {
    for await (const stored of this.storage.findByProcessId(processId)) {
      const state = await this.loadState(stored.instanceId);
      if (state) yield state;
    }
  }

  // ============================================================================
  // Cancellation
  // ============================================================================

  /**
   * Cancel a process instance.
   * Only processes in 'pending' or 'suspended' status can be cancelled.
   * Cleans up subscriptions, timers, and rejects the completion promise.
   *
   * @returns true if the process was cancelled, false if it was already completed/failed
   */
  async cancel(instanceId: string): Promise<boolean> {
    const lockKey = `process:${instanceId}`;
    await this.acquireLock(lockKey);

    try {
      const state = await this.loadState(instanceId);
      if (!state) {
        await this.releaseLock(lockKey);
        return false;
      }

      if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
        await this.releaseLock(lockKey);
        return false;
      }

      state.status = 'cancelled';
      state.completedAt = new Date();

      this.cleanupChildSubscriptions(state);

      const process = this.processRegistry.get(state.processId);
      await this.saveState(state, process);
      this.cleanupSubscriptions(instanceId);
      this.originContexts.delete(instanceId);
      this.handles.delete(instanceId);

      // Signal yield queue completion
      const yieldQueue = this.yieldQueues.get(instanceId);
      if (yieldQueue) {
        yieldQueue.complete();
        this.yieldQueues.delete(instanceId);
      }

      await this.releaseLock(lockKey);

      // Reject completion promise
      const completion = this.completions.get(instanceId);
      if (completion) {
        completion.reject(new Error('Process cancelled'));
        this.completions.delete(instanceId);
      }

      return true;
    } catch (err) {
      await this.releaseLock(lockKey);
      throw err;
    }
  }

  // ============================================================================
  // Yield / Continuation
  // ============================================================================

  /**
   * Create a ProcessContinuation for a generator process.
   * Allows iterating over yielded values with a durable consumer cursor.
   *
   * @param instanceId - The process instance ID
   * @param consumerId - Optional consumer ID for reconnecting to a previous cursor position.
   *                     If not provided, a new consumer is created starting from the beginning.
   */
  async createContinuation<TYield, TReturn>(
    instanceId: string,
    consumerId?: string,
  ): Promise<ProcessContinuation<TYield, TReturn>> {
    const state = await this.loadState(instanceId);
    if (!state) {
      throw new Error(`Process instance not found: ${instanceId}`);
    }

    const resolvedConsumerId = consumerId ?? `consumer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // Load persisted cursor for this consumer
    const consumers = (state.vars.__yieldConsumers ?? {}) as Record<string, { cursor: number }>;
    const initialCursor = consumers[resolvedConsumerId]?.cursor ?? 0;

    // Get or create yield queue
    let yieldQueue = this.yieldQueues.get(instanceId);
    if (!yieldQueue) {
      yieldQueue = createYieldQueue();
      this.yieldQueues.set(instanceId, yieldQueue);

      // If process already finished, signal completion on the new queue
      // so consumers don't hang after draining stored yields
      if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
        yieldQueue.complete();
      }
    }

    // Get or create completion deferred
    let completion = this.completions.get(instanceId) as Deferred<TReturn> | undefined;
    if (!completion) {
      const newCompletion = createDeferred<TReturn>();
      this.completions.set(instanceId, newCompletion as Deferred<unknown>);
      completion = newCompletion;

      if (state.status === 'completed') {
        newCompletion.resolve(state.result as TReturn);
      } else if (state.status === 'failed') {
        newCompletion.reject(new Error(state.error ?? 'Process failed'));
      }
    }

    const storage = this.storage;

    const impl = new ProcessContinuationImpl<TYield, TReturn>(
      instanceId,
      resolvedConsumerId,
      initialCursor,
      state.status,
      yieldQueue,
      async () => {
        const s = await storage.load(instanceId);
        return (s?.variables as Record<string, unknown>)?.__yields as unknown[] ?? [];
      },
      completion,
      async (cid, cursor) => {
        const current = await storage.load(instanceId);
        if (current) {
          const vars = current.variables as Record<string, unknown>;
          const yieldConsumers = (vars.__yieldConsumers ?? {}) as Record<string, { cursor: number }>;
          yieldConsumers[cid] = { cursor };
          vars.__yieldConsumers = yieldConsumers;
          await storage.save(current);
        }
      },
    );

    return impl;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /** Start the timer scheduler */
  startTimers(): void {
    this.timerScheduler.start();
  }

  /** Stop the timer scheduler */
  stopTimers(): void {
    this.timerScheduler.stop();
  }

  /** Clear caches (for testing) */
  clearCaches(): void {
    this.resolvedServicesCache.clear();
    this.completions.clear();
    this.subscriptions.clear();
    this.originContexts.clear();
    this.yieldQueues.clear();
  }
}
