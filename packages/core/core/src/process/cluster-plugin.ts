/**
 * Process Runtime Service
 *
 * Provides durable process execution as a built-in service.
 * Uses Lifecycle for proper cleanup on shutdown.
 *
 * @example
 * ```typescript
 * // ProcessRuntime is automatically available when you add process storage
 * const cluster = createClusterBuilder()
 *   .add(InMemoryProcessStorage)  // Or PostgresProcessStorage
 *   .add(AuthFeature)
 *   .build()
 * ```
 */

import { defineService, type Resolver } from '../core/index.js';
import { AbstractLockProvider, type LockProvider } from '../index.js';
import { Lifecycle } from '../core/lifecycle.js';
import { createProcessExecutor } from '../runtime/process/factory.js';
import { setProcessExecutor } from '../runtime/process/compiled.js';
import { AbstractProcessExecutor, ProcessExecutor } from '../runtime/process/executor.js';
import { AbstractProcessStorage, InMemoryProcessStorage, type ProcessStorage } from '../runtime/process/storage.js';
import { AbstractSignalBus, InMemorySignalBus, type SignalBus } from '../runtime/process/signal-bus.js';
import { InMemoryTimerScheduler, type TimerFired, type TimerScheduler } from '../runtime/process/timer-scheduler.js';
import { createTracer } from '../runtime/process/trace.js';

const { trace } = createTracer('ProcessExecutorService');

// ============================================================================
// Shared Executor Setup
// ============================================================================

interface ExecutorSetupOptions {
  lifecycle: { register(hook: 'stop', fn: () => Promise<void>): void };
  storage: ProcessStorage;
  lockProvider: LockProvider;
  signalBus: SignalBus;
  timerScheduler: TimerScheduler;
  resolve: Resolver;
}

function setupExecutor({ lifecycle, storage, lockProvider, signalBus, timerScheduler, resolve }: ExecutorSetupOptions): ProcessExecutor {
  const executor = createProcessExecutor({
    resolve,
    storage,
    signalBus,
    timerScheduler,
    lockProvider,
  });

  setProcessExecutor(executor);
  executor.startTimers();

  lifecycle.register('stop', async () => {
    executor.stopTimers();
    executor.clearCaches();
    setProcessExecutor(null);
  });

  return executor;
}

// ============================================================================
// Process Executor Service
// ============================================================================

/**
 * ProcessExecutorService - Provides a ProcessExecutor for dependency injection.
 *
 * Requires:
 * - AbstractProcessStorage for process state persistence
 * - AbstractLockProvider for distributed locking
 */
export const ProcessExecutorService = defineService({
  inject: {
    lifecycle: Lifecycle,
    storage: AbstractProcessStorage,
    lockProvider: AbstractLockProvider,
    signalBus: AbstractSignalBus,
  },
  factory: (
    { lifecycle, storage, lockProvider, signalBus },
    resolve: Resolver
  ): AbstractProcessExecutor => {
    trace('factory', { signalBusType: signalBus?.constructor?.name });
    const timerScheduler = new InMemoryTimerScheduler();
    return setupExecutor({ lifecycle, storage, lockProvider, signalBus, timerScheduler, resolve });
  },
});

// ============================================================================
// Process Runtime Service Interface
// ============================================================================

/**
 * Process runtime interface for controller injection.
 *
 * @example
 * ```typescript
 * const MyController = createController({
 *   inject: { runtime: ProcessRuntimeService },
 *   routes: ({ runtime }) => ({
 *     emitSignal: Post('/emit').handle(async () => {
 *       await runtime.emit('order.shipped', { orderId: '123' })
 *     })
 *   })
 * })
 * ```
 */
export interface ProcessRuntimeInstance {
  /** The canonical executor (same instance bound to AbstractProcessExecutor). */
  executor: ProcessExecutor
  /** The bound signal bus — InMemory or Pg depending on AbstractSignalBus binding. */
  signalBus: SignalBus
  emit(signal: string, identity: Record<string, string>, payload?: unknown): Promise<void>
  handleTimerFired(fired: TimerFired): void
}

// ============================================================================
// Process Runtime Service
// ============================================================================

/**
 * ProcessRuntimeService - Adapter exposing the canonical process executor
 * to controllers. Delegates `emit` and `handleTimerFired` to whatever
 * executor is bound as `AbstractProcessExecutor`, so a controller using
 * this service hits the same bus and timer scheduler as the compiled
 * process callsites.
 *
 * Requires:
 * - AbstractProcessExecutor (provided by ProcessExecutorService via
 *   InMemoryProcessFeature / PostgresProcessFeature)
 * - AbstractSignalBus (in-memory or Pg, depending on the feature wired up)
 *
 * @example
 * ```typescript
 * const MyController = createController({
 *   inject: { runtime: ProcessRuntimeService },
 *   routes: ({ runtime }) => ({
 *     emit: Post('/emit').handle(async (ctx) => {
 *       await runtime.emit('order.shipped', { orderId: ctx.body.orderId })
 *     })
 *   })
 * })
 * ```
 */
export class ProcessRuntimeService extends defineService({
  inject: {
    executor: AbstractProcessExecutor,
    signalBus: AbstractSignalBus,
  },
  factory: ({ executor, signalBus }): ProcessRuntimeInstance => {
    // Adapter, not a parallel runtime: we delegate to the canonical executor
    // bound via `bindService(AbstractProcessExecutor, ProcessExecutorService)`.
    // Previously this factory built its own ProcessExecutor + InMemorySignalBus
    // + InMemoryTimerScheduler, which silently routed `runtime.emit()` and
    // `runtime.handleTimerFired()` to a parallel bus that had no subscribers
    // — signals + delays were lost in pg multi-instance apps the moment a
    // controller injected ProcessRuntimeService.
    const concreteExecutor = executor as unknown as ProcessExecutor;
    return {
      executor: concreteExecutor,
      signalBus,
      emit: async (signal, identity, payload) => {
        await concreteExecutor.emit(signal, identity, payload);
      },
      handleTimerFired: (fired) => {
        concreteExecutor.receiveTimerFire(fired);
      },
    };
  },
}) {}


// Re-export types for controller authors
export type { TimerFired } from '../runtime/process/timer-scheduler.js';
export type { TimerPayload } from '../runtime/process/scheduled-task-timer.js';

// Re-export storage for convenience
export { AbstractProcessStorage, InMemoryProcessStorage };
export { AbstractProcessExecutor };

// ============================================================================
// In-Memory Signal Bus Service
// ============================================================================

/**
 * Service that provides in-memory signal bus.
 * Signals only work within a single process instance.
 */
export const InMemorySignalBusService = defineService({
  inject: {},
  factory: (): AbstractSignalBus => new InMemorySignalBus(),
});

// ============================================================================
// In-Memory Process Feature
// ============================================================================

import { bindService, createFeatureBuilder } from '../builder/index.js';

/**
 * Feature that sets up in-memory process storage and executor.
 *
 * Useful for development and testing. Process state is lost on restart.
 *
 * Requires:
 * - AbstractLockProvider (use InMemoryLockFeature from @justscale/core/memory)
 *
 * Provides:
 * - AbstractProcessStorage (in-memory)
 * - AbstractSignalBus (in-memory)
 * - AbstractProcessExecutor (for creating signals in services)
 *
 * @example
 * ```typescript
 * import JustScale from '@justscale/core'
 * import { InMemoryProcessFeature } from '@justscale/core/process'
 * import { InMemoryLockFeature } from '@justscale/core/memory'
 *
 * JustScale()
 *   .add(InMemoryLockFeature)     // Required for process locking
 *   .add(InMemoryProcessFeature)  // Processes use in-memory storage
 *   .add(AuthFeature)
 *   .build()
 * ```
 */
export const InMemoryProcessFeature = createFeatureBuilder()
  .name('InMemoryProcess')
  .requires(Lifecycle)
  .requires(AbstractLockProvider)
  .provides((b) =>
    b
      .add(InMemoryProcessStorage)  // Auto-provides AbstractProcessStorage
      .add(InMemorySignalBusService)
      .add(bindService(AbstractSignalBus, InMemorySignalBusService))  // In-memory signal bus
      .add(ProcessExecutorService)
      .add(bindService(AbstractProcessExecutor, ProcessExecutorService)),
  );
