/**
 * @justscale/process - Testing Utilities
 *
 * Helpers for setting up process runtime in tests.
 */

import type { Container, Resolver } from '../core/index.js';
import type { LockProvider } from '../index.js';
import { createInMemoryRuntime, type InMemoryRuntime } from '../runtime/process/factory.js';
import { setProcessExecutor } from '../runtime/process/compiled.js';
import { AbstractProcessExecutor } from '../runtime/process/executor.js';
import { TestClock, createTestClock } from './testing/clock.js';

// Re-export testing utilities
export { TestClock, createTestClock };

export interface SetupTestProcessRuntimeOptions {
  /** Optional lock provider for testing locking behavior */
  lockProvider?: LockProvider
}

/**
 * Set up process runtime for testing.
 *
 * Creates an in-memory process runtime and sets it as the global executor.
 * Also registers the executor for DI so services can inject AbstractProcessExecutor.
 * Returns the runtime for test control (emitting signals, advancing timers).
 *
 * @example
 * ```typescript
 * import { setupTestProcessRuntime, TestClock } from '@justscale/process'
 *
 * const app = built.compile()
 * await app.ready
 *
 * const runtime = setupTestProcessRuntime(app.container)
 * const clock = new TestClock(runtime.timerScheduler)
 *
 * // Now processes will work
 * await myProcess(['param'])
 *
 * // Emit signals in tests
 * await runtime.signalBus.emit('some.signal', { id: '123' }, { data: 'payload' })
 *
 * // Time travel - advance by duration
 * await clock.advance.minutes(5)
 * await clock.advance.hours(1)
 *
 * // Or fire next timer directly
 * clock.fireNext()
 *
 * // Clean up
 * runtime.stop()
 * ```
 */
export function setupTestProcessRuntime(
  container: Container,
  options: SetupTestProcessRuntimeOptions = {}
): InMemoryRuntime {
  // Create a resolver function that wraps the container
  const resolve = ((token: any) => container.resolve(token)) as Resolver;

  const runtime = createInMemoryRuntime({
    resolve,
    autoStart: true,
    lockProvider: options.lockProvider,
  });

  setProcessExecutor(runtime.executor);

  // Register executor for DI-based signal creation
  container.registerInstance(AbstractProcessExecutor, runtime.executor);

  return runtime;
}
