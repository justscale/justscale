/**
 * @justscale/process - Runtime Factory
 *
 * Convenience factories for creating process runtime configurations.
 */

import type { Resolver } from '../../core/index.js';
import type { LockProvider } from '../../index.js';
import { ProcessExecutor, type ProcessExecutorOptions } from './executor.js';
import { createInMemoryProcessStorage, type InMemoryProcessStorageInstance } from './storage.js';
import { InMemorySignalBus } from './signal-bus.js';
import { InMemoryTimerScheduler } from './timer-scheduler.js';

// ============================================================================
// In-Memory Runtime
// ============================================================================

export interface InMemoryRuntimeOptions {
  /** Resolver function for resolving services */
  resolve: Resolver
  /** Whether to start the timer scheduler immediately (default: true) */
  autoStart?: boolean
  /** Lock provider for exclusive process execution (prevents dead letters) */
  lockProvider?: LockProvider
}

export interface InMemoryRuntime {
  /** The process executor */
  executor: ProcessExecutor
  /** Direct access to storage (for testing) */
  storage: InMemoryProcessStorageInstance
  /** Direct access to signal bus (for testing) */
  signalBus: InMemorySignalBus
  /** Direct access to timer scheduler (for testing) */
  timerScheduler: InMemoryTimerScheduler
  /** Start the runtime (timer scheduler) */
  start(): void
  /** Stop the runtime */
  stop(): void
  /** Clear all state (for testing) */
  clear(): void
}

/**
 * Create an in-memory process runtime.
 *
 * Suitable for testing and single-node development.
 * State is lost on restart.
 *
 * @example
 * ```ts
 * const runtime = createInMemoryRuntime({ container })
 * setProcessExecutor(runtime.executor)
 *
 * // In tests
 * runtime.signalBus.emit('orders.shipped', { orderId: '123' })
 * runtime.timerScheduler.advanceTo(futureDate)
 * ```
 */
export function createInMemoryRuntime(options: InMemoryRuntimeOptions): InMemoryRuntime {
  const storage = createInMemoryProcessStorage();
  const signalBus = new InMemorySignalBus();
  const timerScheduler = new InMemoryTimerScheduler();

  const executor = new ProcessExecutor({
    resolve: options.resolve,
    storage,
    signalBus,
    timerScheduler,
    lockProvider: options.lockProvider,
  });

  if (options.autoStart !== false) {
    timerScheduler.start();
  }

  return {
    executor,
    storage,
    signalBus,
    timerScheduler,
    start: () => executor.startTimers(),
    stop: () => {
      executor.stopTimers();
      executor.clearCaches();
    },
    clear: () => {
      storage.clear();
      signalBus.clear();
      timerScheduler.clear();
      executor.clearCaches();
    },
  };
}

// ============================================================================
// Custom Runtime
// ============================================================================

/**
 * Create a process executor with custom infrastructure components.
 *
 * @example
 * ```ts
 * // PostgreSQL-backed runtime
 * const executor = createProcessExecutor({
 *   container,
 *   storage: new PgProcessStorage(client),
 *   signalBus: new PgSignalBus(pubsub),
 *   timerScheduler: new PgTimerScheduler(client),
 * })
 * ```
 */
export function createProcessExecutor(options: ProcessExecutorOptions): ProcessExecutor {
  return new ProcessExecutor(options);
}

// ============================================================================
// Re-exports
// ============================================================================

export type { ProcessStorage } from './storage.js';
export type { SignalBus, SignalMatch, SignalSubscription, RaceSubscription, RaceBranch, PendingSignal } from './signal-bus.js';
export type { TimerScheduler, ScheduledTimer, TimerFired } from './timer-scheduler.js';
export type { ProcessExecutorOptions } from './executor.js';
