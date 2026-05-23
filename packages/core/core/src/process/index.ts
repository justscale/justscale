/**
 * @justscale/process - Durable Processes
 *
 * Provides primitives for building durable, resumable processes
 * with serializable state.
 */

// Type exports from types.ts
export type {
  Signal,
  ExtractPathParams,
  ExtractHandlerParams,
  ParamValue,
  ModelClass,
  TypedParams,
  ProcessConfig,
  ProcessHandle,
  ProcessStatus,
  ProcessDefinition,
  ProcessContinuation,
  ProcessState,
  TimerState,
  SignalDefinition,
  // Label tracking types (observability)
  LabelHistoryEntry,
  // Switch-based execution model types
  TimerDuration,
  SuspendSignalConfig,
  SuspendTimerConfig,
  SuspendRaceBranch,
  SuspendRaceConfig,
  SuspendConfig,
  ExecutionResult,
  ExecutionContext,
  SwitchProcessState,
  CompiledSwitchProcess,
  ProcessExportsMetadata,
  ExportsData,
  CompiledSubProcess,
  SubProcessSpawnConfig,
} from './types.js';

// Execution result discriminants
export { DONE, SUSPEND, SUBPROCESS } from './types.js';

// Process factory
export { createProcess, createSubProcess, SUBPROCESS_DEFINITION } from './createProcess.js';

// Signal group definition (defineSignals with path-based builder API)
export { defineSignals } from './define-signals.js';
export type { BuiltSignal, SignalBuilder, SignalFactory } from './define-signals.js';

// Primitives for process control flow
export { signal, race, delay, scope, stream } from './primitives.js';

// Durable iterator protocol
export {
  DurableCursor,
  FromCursor,
  DurableArrayIterator,
  isDurableIterable,
  createDurableArrayIterator,
} from './primitives.js';

// Detection helpers for signal types
export {
  isSignalAllPlaceholder,
  isSignalSettledPlaceholder,
  isStreamPlaceholder,
} from './primitives.js';

// Re-export types
export type {
  Duration,
  DelayPrimitive,
  DurableCursorType,
  DurableIterable,
  DurableQueryIterable,
  SettledResult,
  ScopePrimitive,
  ScopeResult,
  IdExtractor,
  ScopeHandler,
  StreamPrimitive,
} from './primitives.js';

// Scope detection helper
export { isScopePlaceholder } from './primitives.js';

// Stream-process utilities
export {
  modelNameToIdentityKey,
  pascalToCamelCase,
  parseStreamSignal,
  buildStreamSignal,
  isWildcardStreamSignal,
  resolveEntityId,
  resolveStreamWildcard,
} from './stream-utils.js';
export type {
  StreamSignalParts,
  IdentityResolutionOptions,
  IdentityResolutionResult,
} from './stream-utils.js';

// Runtime (for compiled processes)
export { __createProcess, setProcessExecutor, getProcessExecutor, withExecutor, registerCompiledProcess } from '../runtime/process/compiled.js';
export {
  ProcessExecutor,
  AbstractProcessExecutor,
  generateInstanceId,
  resolvePath,
  extractIdentity,
} from '../runtime/process/executor.js';
export type { ProcessExecutorContract } from '../runtime/process/executor.js';

// Processable protocol — unified serialization for processes, channels, signals
/// <reference path="./serialization.global.d.ts" />
export {
  registerProcessType,
  getProcessDescriptor,
  getProcessRegistry,
  isProcessable,
  hasProcessDescriptor,
  ensureRegistered,
  findProcessDescriptor,
  encodeProcessable,
  decodeProcessable,
} from './serialization.js';

// Built-in Processable types (Date, Map, Set, Reference) — side-effect registration
import './builtin-serializers.js';

// State serialization for JSONB round-trips
export { serializeState, deserializeState } from '../runtime/process/state-serializer.js';

// Storage abstraction
export { InMemoryProcessStorage, AbstractProcessStorage } from '../runtime/process/storage.js';
export type { ProcessStorage } from '../runtime/process/storage.js';

// Signal bus abstraction
export { AbstractSignalBus, InMemorySignalBus } from '../runtime/process/signal-bus.js';
export type {
  SignalBus,
  SignalMatch,
  SignalSubscription,
  RaceSubscription,
  RaceBranch as SignalRaceBranch,
  PendingSignal,
} from '../runtime/process/signal-bus.js';

// Timer scheduler abstraction
export { InMemoryTimerScheduler } from '../runtime/process/timer-scheduler.js';
export type { TimerScheduler, ScheduledTimer, TimerFired } from '../runtime/process/timer-scheduler.js';

// Scheduled task-backed timer scheduler
export {
  ScheduledTaskTimerScheduler,
  TIMER_NAMESPACE,
  TIMER_TYPE,
} from '../runtime/process/scheduled-task-timer.js';
export type { TimerPayload } from '../runtime/process/scheduled-task-timer.js';

// Factory for creating runtime configurations
export { createInMemoryRuntime, createProcessExecutor } from '../runtime/process/factory.js';
export type { InMemoryRuntime, InMemoryRuntimeOptions, ProcessExecutorOptions } from '../runtime/process/factory.js';

// Testing helper
export { setupTestProcessRuntime, TestClock, createTestClock } from './testing.js';

// Process Runtime Service
export {
  InMemoryProcessFeature,
  ProcessExecutorService,
  ProcessRuntimeService,
} from './cluster-plugin.js';
export type { ProcessRuntimeInstance } from './cluster-plugin.js';
