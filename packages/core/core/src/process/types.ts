/**
 * @justscale/process - Core Types
 *
 * Type definitions for durable processes.
 */

import type { ServiceToken, ResolvedDeps } from '../core/index.js';
import type { TypesConfig, TypedParams, ExtractParamNames, Prettify } from '../models/apply-types-config.js';

// ============================================================================
// Signal Types
// ============================================================================

/** Brand symbol for Signal type */
export const SIGNAL_BRAND = Symbol.for('@justscale/process/signal');

/**
 * A Signal represents a suspension point in a process.
 *
 * Usage:
 * - Inside process: `await signal(orders.complete)` - suspends until signal emitted
 * - Outside process: `await orders.complete(orderId)` - emits signal to instance
 *
 * Create signals with `defineSignals()`:
 * ```typescript
 * class OrderSignals extends defineSignals(signal => ({
 *   complete: signal('/order/:order/complete').types({ Order }),
 *   shipped: signal('/order/:order/shipped').data<ShipmentDetails>().types({ Order }),
 * })) {}
 * ```
 *
 * @typeParam TIdentity - Tuple of identity parameters for routing
 * @typeParam TPayload - Payload type returned when signal is received
 * @typeParam TName - Literal signal name (inferred from createSignal)
 */
export interface Signal<
  TIdentity extends readonly unknown[] = [],
  TPayload = void,
  TName extends string = string,
> extends PromiseLike<TPayload> {
  /** Call to emit the signal (from outside a process) */
  (...args: [...TIdentity, ...(TPayload extends void ? [] : [TPayload])]): Promise<void>
  /** Brand for type safety */
  readonly [SIGNAL_BRAND]: typeof SIGNAL_BRAND
  /** Signal name for routing (literal type for switch narrowing) */
  readonly signalName: TName
  /** Phantom types for inference */
  readonly __identity: TIdentity
  readonly __payload: TPayload
}

// ============================================================================
// Path Parameter Extraction
// ============================================================================

/**
 * A process param value: a plain string, or anything with an `identifier` property
 * (e.g. a Reference, or Model.ref(entity)).
 *
 * This lets you write `process([Table.ref(table)])` instead of
 * `process([Table.ref(table).identifier])`.
 */
export type ParamValue = string | { readonly identifier: string };

/**
 * Extract params for calling a process — accepts strings or refs.
 * "/order/:orderId/:customerId" → readonly [orderId: ParamValue, customerId: ParamValue]
 */
export type ExtractPathParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? readonly [Param: ParamValue, ...ExtractPathParams<`/${Rest}`>]
    : Path extends `${string}:${infer Param}`
      ? readonly [Param: ParamValue]
      : readonly [];

/**
 * Extract params for the handler as a named object.
 * "/order/:orderId/:customerId" → { orderId: string, customerId: string }
 */
export type ExtractHandlerParams<Path extends string> = Prettify<{
  [P in ExtractParamNames<Path>]: string
}>;

// Re-export shared type utilities (used by processes and controllers)
export type { TypedParams, TypesConfig, ExtractParamNames, Prettify } from '../models/apply-types-config.js';

/**
 * Any model class with a static `ref` method.
 * Used in the `types` config to map path params to model references.
 */
export type ModelClass = abstract new (...args: any[]) => any;

// ============================================================================
// Process Definition
// ============================================================================

/**
 * Configuration for createProcess.
 */
export interface ProcessConfig<
  TPath extends string,
  TDeps extends Record<string, ServiceToken>,
  TResult,
  TExports = void,
  TTypes extends Record<string, ModelClass> = {},
> {
  /** Route-style path for process identity, e.g., '/order/:orderId/fulfillment' */
  path: TPath
  /** Dependencies to inject (same pattern as defineService) */
  inject: TDeps
  /**
   * Map path params to model types. Matched params become `Ref<T>` in the handler.
   *
   * Matching: key matches param name directly, or lowercased.
   * `types: { Table }` matches `:table` in the path.
   * `types: { tableId: Table }` matches `:tableId` in the path.
   *
   * @example
   * ```typescript
   * createProcess({
   *   path: '/poker/:table/game/:gameId',
   *   types: { Table },
   *   handler(deps, { table, gameId }) {
   *     // table: Ref<Table>  — use directly with repos
   *     // gameId: string     — untyped param
   *   }
   * })
   * ```
   */
  types?: TTypes
  /** The process handler function */
  handler: (
    deps: Prettify<ResolvedDeps<TDeps>>,
    params: keyof TTypes extends never
      ? ExtractHandlerParams<TPath>
      : TypedParams<TPath, TTypes>
  ) => Promise<TResult>
  /** Phantom: carries the exports type. Emitted by compiler, never set by users. */
  __exportsType?: TExports
}

/**
 * A handle to a running or completed process instance.
 *
 * Note: ProcessHandle is intentionally NOT a thenable (no `then` method).
 * This is to avoid JavaScript's automatic unwrapping when returning from
 * async functions. Use `handle.wait()` to await the process result.
 */
export type ExportsData<T> = Readonly<T> & AsyncIterable<Readonly<T>>;

export interface ProcessHandle<TResult, TExports = void> {
  /** Unique instance ID (derived from path + params) */
  readonly id: string
  /** The resolved path, e.g., '/order/123/abc/fulfillment' */
  readonly path: string
  /** Current process status */
  readonly status: ProcessStatus
  /** Result if completed (snapshot, may be stale) */
  readonly result?: TResult
  /** Error if failed (snapshot, may be stale) */
  readonly error?: Error
  /** Frozen, read-only replica of process exports. AsyncIterable for live updates. */
  readonly data: [TExports] extends [void] ? undefined : ExportsData<TExports>
  /**
   * Async iterable that emits each status transition.
   * Ends (done: true) when the process reaches a terminal state.
   */
  readonly statusChanges: AsyncIterable<ProcessStatus>
  /**
   * Wait for the process to complete and return its result.
   * Use `await handle.wait()` to block until process completes.
   */
  wait(): Promise<TResult>
  /**
   * Cancel the process.
   * Only pending or suspended processes can be cancelled.
   * @returns true if the process was cancelled, false if already completed/failed
   */
  cancel(): Promise<boolean>
}

export type ProcessStatus = 'pending' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';

// ============================================================================
// Process Continuation (for generator handlers with yields)
// ============================================================================

/**
 * A continuation handle for processes that yield events.
 *
 * ProcessContinuation allows you to:
 * - Iterate over yielded events as they occur
 * - Wait for the final result
 * - Check the current status
 * - Cancel the subscription (without killing the process)
 *
 * @example
 * ```typescript
 * // Subscribe to process yields
 * const continuation = await OrderBatch(['batch-123'])
 *
 * // Iterate over events as they're yielded
 * for await (const event of continuation) {
 *   console.log('Order processed:', event.orderId)
 * }
 *
 * // Get the final result
 * const result = await continuation.result
 * console.log('Batch complete:', result)
 * ```
 */
export interface ProcessContinuation<TYield, TReturn = void> {
  /**
   * Async iterator over yielded events.
   * Each iteration returns the next yielded value from the process.
   * Consumer cursor is persisted — break/return/cancel persists progress.
   */
  [Symbol.asyncIterator](): AsyncIterator<TYield>

  /**
   * Promise that resolves when the process COMPLETES (not just suspends).
   * Returns the final return value of the handler.
   */
  readonly result: Promise<TReturn>

  /**
   * Current process status.
   */
  readonly status: ProcessStatus

  /**
   * Unique instance ID (derived from path + params).
   */
  readonly id: string

  /**
   * Unique consumer ID for this continuation.
   * Use this to reconnect and resume from the persisted cursor.
   */
  readonly consumerId: string

  /**
   * Cancel the subscription to yields.
   * Persists the consumer cursor so reconnection resumes where we left off.
   * This does NOT kill or stop the process.
   */
  cancel(): Promise<void>
}

/**
 * A process definition - callable to start instances.
 * Also acts as a ServiceToken so processes can be injected.
 */
export interface ProcessDefinition<
  TPath extends string,
  TParams extends readonly unknown[],
  TResult,
  TExports = void,
> {
  /** The path pattern */
  readonly path: TPath

  /**
   * Start a new process instance.
   * Idempotent: if a process with these params already exists, returns its handle.
   */
  (params: TParams): Promise<ProcessHandle<TResult, TExports>>

  /**
   * Get an existing process by params without starting a new one.
   * Returns null if no process exists for these params.
   */
  get(params: TParams): Promise<ProcessHandle<TResult, TExports> | null>

  /**
   * Query processes by partial params pattern.
   */
  query(pattern: Partial<Record<string, string>>): AsyncIterable<ProcessHandle<TResult, TExports>>

  /**
   * Emit a signal to processes waiting for it.
   * @deprecated Use service methods instead. Provided for testing.
   */
  emit(signal: string, identity: unknown[], payload: unknown): Promise<void>

  /** Placeholder for DI token support on exports. */
  readonly exports: undefined

  // ServiceDef compatibility - allows processes to be injected like services
  /** Dependencies (same as inject config) */
  readonly deps: Record<string, ServiceToken>
  /** Factory function that returns the process callable */
  readonly factory: (resolvedDeps: Record<string, unknown>) => (params: TParams) => Promise<ProcessHandle<TResult, TExports>>
}

// ============================================================================
// Process State (Internal)
// ============================================================================

/**
 * Serialized process state stored in database.
 */
export interface ProcessState<TVariables = Record<string, unknown>> {
  /** Process definition ID */
  processId: string
  /** Instance ID (derived from path + params) */
  instanceId: string
  /** Version hash of opcode structure */
  version: string
  /** Program counter - current opcode index */
  pc: number
  /** Serialized variables */
  variables: TVariables
  /** Pending timers */
  timers: TimerState[]
  /** Metadata */
  createdAt: Date
  updatedAt: Date
  suspendedAt?: Date
  completedAt?: Date
  status: ProcessStatus
  result?: unknown
  error?: string
  /** Last recoverable error (e.g. DoubleLockError). See SwitchProcessState.lastError. */
  lastError?: string
  /** Timestamp of the last recoverable error. */
  lastErrorAt?: Date
}

export interface TimerState {
  id: string
  expiresAt: Date
  opcodeIndex: number
}

// ============================================================================
// Signal Definition (shared by switch model)
// ============================================================================

export interface SignalDefinition {
  identity: string[]
  payloadType: string
}

// ============================================================================
// Race Result Types (for type-safe switch narrowing)
// ============================================================================

/** Unique symbol for delay branches in race */
declare const DELAY_BRANCH_SYMBOL: unique symbol;
export const DELAY_BRANCH: typeof DELAY_BRANCH_SYMBOL = Symbol('delay') as typeof DELAY_BRANCH_SYMBOL;
export type DelayBranch = typeof DELAY_BRANCH;

/**
 * Extract payload type from a Signal.
 */
export type SignalPayload<S> = S extends Signal<infer _I, infer P, infer _N> ? P : never;

/**
 * Extract signal name from a Signal.
 */
export type SignalName<S> = S extends Signal<infer _I, infer _P, infer N> ? N : never;

/**
 * A race branch definition - either a signal or a delay.
 */
export type RaceBranchType<TName extends string = string, TPayload = void> = {
  readonly name: TName
  readonly __payload: TPayload
};

/**
 * Build a race result variant from a signal or delay.
 * Spreads payload properties directly onto the result (no .payload wrapper).
 * TName can be a string (signal name) or symbol (DELAY_BRANCH).
 */
export type RaceVariant<TName extends string | symbol, TPayload> = { which: TName } & (
  TPayload extends void ? {} :
    TPayload extends object ? TPayload :
      { value: TPayload }
);

/**
 * Union of race result variants from a tuple of signals.
 *
 * @example
 * ```typescript
 * type Signals = [
 *   Signal<[], { code: string }, 'auth.code'>,
 *   Signal<[], void, 'auth.cancel'>,
 * ]
 * type Result = RaceResult<Signals>
 * // = { which: 'auth.code'; code: string } | { which: 'auth.cancel' }
 * ```
 */
export type RaceResult<TBranches extends readonly unknown[]> = {
  [K in keyof TBranches]: TBranches[K] extends Signal<infer _I, infer P, infer N>
    ? RaceVariant<N, P>
    : TBranches[K] extends DelayBranch
      ? RaceVariant<DelayBranch, void>
      : never
}[number];

/**
 * Helper to create a race result type from signal types.
 * Use with `race<RaceOf<typeof sig1 | typeof sig2>>()`.
 */
export type RaceOf<TSignals> = TSignals extends Signal<infer _I, infer P, infer N>
  ? RaceVariant<N, P>
  : TSignals extends DelayBranch
    ? RaceVariant<DelayBranch, void>
    : never;

// ============================================================================
// Label Tracking Types (Observability)
// ============================================================================

/**
 * Entry in the label history for observability.
 * Tracks when the process entered and exited named blocks.
 */
export interface LabelHistoryEntry {
  /** The label name (e.g., 'waitForPayment') */
  label: string
  /** Step number when the label was entered */
  enteredAt: number
  /** Step number when the label was exited (undefined if still active) */
  exitedAt?: number
}

// ============================================================================
// Switch-Based Execution Model Types
// ============================================================================

/** Execution result discriminant - process completed */
export const DONE = 0 as const;
/** Execution result discriminant - process suspended */
export const SUSPEND = 1 as const;
/** Execution result discriminant - spawn subprocess */
export const SUBPROCESS = 2 as const;

/**
 * Timer duration specification for delay branches.
 */
export interface TimerDuration {
  hours?: number
  minutes?: number
  seconds?: number
  days?: number
}

/**
 * Configuration for suspending on a single signal.
 */
export interface SuspendSignalConfig {
  signal: string
}

/**
 * Configuration for suspending on a timer.
 */
export interface SuspendTimerConfig {
  timer: TimerDuration
}

/**
 * Configuration for a race branch in suspend config.
 */
export interface SuspendRaceBranch {
  id: string
  signal?: string
  timer?: TimerDuration
  resumeStep: number
}

/**
 * Configuration for suspending on a race (multiple branches).
 */
export interface SuspendRaceConfig {
  race: SuspendRaceBranch[]
}

/**
 * Configuration for suspending on a scope (parallel fan-out).
 */
export interface SuspendScopeConfig {
  scope: {
    scopeId: number
    type: 'signal' | 'handler'
    signal?: unknown
    resumeStep: number
  }
}

/**
 * A branch in a parallel (signal.all / signal.settled) suspension.
 */
export interface SuspendParallelBranch {
  id: string | number
  type: 'signal' | 'delay' | 'function'
  /** Signal expression (has .signalName) for signal branches */
  expr?: unknown
}

/**
 * Configuration for suspending on parallel signal.all() / signal.settled().
 */
export interface SuspendParallelConfig {
  parallel: {
    parallelId: number
    pending: number
    results: unknown[]
    errors: unknown[]
    isSettled: boolean
    branches: SuspendParallelBranch[]
  }
}

/**
 * Union of suspend configurations.
 */
export type SuspendConfig = SuspendSignalConfig | SuspendTimerConfig | SuspendRaceConfig | SuspendScopeConfig | SuspendParallelConfig;

export interface SubProcessSpawnConfig {
  name: string
  args: unknown[]
  storeVar?: string
  /**
   * True when the source call expression was `await child(...)`.
   * Executor suspends the parent until the child reaches DONE. False for
   * detached spawns; parent continues past the spawn point with a handle
   * (or undefined storeVar) and the child runs independently.
   */
  awaited: boolean
}

/**
 * Result tuple from process execution.
 * - [DONE, result] - Process completed with result
 * - [SUSPEND, config] - Process suspended, needs to wait for signal/timer
 * - [SUBPROCESS, config] - Spawn a subprocess
 */
export type ExecutionResult =
  | readonly [typeof DONE, unknown]
  | readonly [typeof SUSPEND, SuspendConfig]
  | readonly [typeof SUBPROCESS, SubProcessSpawnConfig];

/**
 * Execution context passed to the compiled process execute function.
 */
export interface ExecutionContext {
  /** Current process state */
  state: SwitchProcessState
  /** Resolved service dependencies */
  services: Record<string, unknown>
  /** Signal payload when resuming from a signal */
  signalPayload?: unknown
  /** Emit a yielded value (for generator processes). Fire-and-forward, no suspension. */
  emit: (value: unknown) => void
}

/**
 * Process state for switch-based execution model.
 * Uses step (hash) instead of pc (opcode index).
 */
export interface SwitchProcessState<TVariables = Record<string, unknown>> {
  /** Process definition ID */
  processId: string
  /** Instance ID (derived from path + params) */
  instanceId: string
  /** Version hash of process structure */
  version: string
  /** Current step index (numeric for execution) */
  step: number
  /** Persisted step hash (for storage/resume) */
  persistedStep: string
  /** Serialized variables */
  vars: TVariables
  /** Pending timers */
  timers: TimerState[]
  /** Metadata */
  createdAt: Date
  updatedAt: Date
  suspendedAt?: Date
  completedAt?: Date
  status: ProcessStatus
  result?: unknown
  error?: string

  /**
   * Last recoverable error thrown by a handler pass that left the process
   * suspended at its prior step (e.g. DoubleLockError). Cleared when a
   * subsequent execute either advances the step or completes.
   *
   * Distinct from `error` which is only set alongside `status: 'failed'`.
   */
  lastError?: string
  /** Timestamp of the last recoverable error. Pairs with `lastError`. */
  lastErrorAt?: Date

  // Label tracking for observability
  /** Current label (innermost active label block) */
  label?: string
  /** Stack of nested label names (outermost first) */
  labelStack?: string[]
  /** History of label transitions (circular buffer, max 50 entries) */
  labelHistory?: LabelHistoryEntry[]
}

/**
 * Compiled process using switch-based execution model.
 * Generated by the process compiler.
 */
export interface ProcessExportsMetadata {
  /** Data field names (serialized in JSONB) */
  fields: string[]
  /** Method implementations (reattached on resume, NOT serialized) */
  methods: Record<string, Function>
}

export interface CompiledSwitchProcess<TDeps extends Record<string, ServiceToken> = Record<string, ServiceToken>, TExports = unknown> {
  /** Process identifier */
  id: string
  /** Route path pattern */
  path: string
  /** Version hash for migration detection */
  version: string
  /** Service dependencies to inject */
  inject: TDeps
  /** Hash → index mapping for persistence stability */
  stepMap: Record<string, number>
  /** Index → [startLine, endLine] for debugging */
  sourceMap: Record<number, [number, number]>
  /** Signal definitions */
  signals: Record<string, SignalDefinition>
  /** The VM-style execute function */
  execute: (ctx: ExecutionContext) => Promise<ExecutionResult>
  /** Exports metadata — present when handler uses `using exports = { ... }` */
  exports?: ProcessExportsMetadata
  /** Subprocess definitions — present when handler uses createSubProcess() */
  subprocesses?: CompiledSubProcess[]
  /**
   * Types config — maps path param names to model classes.
   * When present, the executor wraps matching string params with Model.ref().
   * Keys match param names directly or lowercased (e.g., { Table } matches :table).
   */
  types?: TypesConfig
  /** Phantom property carrying the exports type — emitted by compiler, never read at runtime */
  __exportsType?: TExports
}

export interface CompiledSubProcess {
  /** Subprocess name (e.g., 'player') */
  name: string
  /** Subprocess path suffix (e.g., '/:playerId') */
  path: string
  /** Handler parameter names */
  params: string[]
  /** Step map for the subprocess handler */
  stepMap: Record<string, number>
  /** Signal definitions for the subprocess */
  signals: Record<string, SignalDefinition>
  /** The subprocess execute function */
  execute: (ctx: ExecutionContext) => Promise<ExecutionResult>
  /** Subprocess exports metadata */
  exports?: ProcessExportsMetadata
}
