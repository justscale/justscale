/**
 * @justscale/process - Compiled Process Runtime
 *
 * Runtime support for compiled switch-based processes.
 * The compiler transforms createProcess() calls into __createProcess() calls.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ServiceToken } from '../../core/index.js';
import { getContainer } from '../../core/context.js';
import type {
  CompiledSwitchProcess,
  ExtractPathParams,
  ProcessDefinition,
  ProcessHandle,
} from '../../process/types.js';
import { AbstractProcessExecutor, type ProcessExecutor, generateInstanceId, extractIdentity } from './executor.js';
import { createTracer } from './trace.js';

const { trace } = createTracer('CompiledProcess');

/**
 * Symbol marking a compiled switch-based process.
 */
export const COMPILED_PROCESS = Symbol('justscale:compiledSwitchProcess');

/**
 * Runtime function called by compiled process code.
 * This is what createProcess() gets transformed into.
 */
export function __createProcess<
  TPath extends string,
  TDeps extends Record<string, ServiceToken>,
  TResult,
  TExports = void,
>(
  compiled: CompiledSwitchProcess<TDeps, TExports>
): ProcessDefinition<TPath, ExtractPathParams<TPath>, TResult, TExports> {
  type TParams = ExtractPathParams<TPath>;

  registerCompiledProcess(compiled as CompiledSwitchProcess<Record<string, ServiceToken>>);

  const processCallable = async (params: TParams): Promise<ProcessHandle<TResult, TExports>> => {
    trace('processCallable', { params });
    // Get the executor from the current context
    const executor = getProcessExecutor();
    trace('executor', { type: executor?.constructor?.name ?? 'null' });
    if (!executor) {
      throw new Error(
        'No ProcessExecutor available. Ensure you\'re running within a JustScale application context.'
      );
    }

    return executor.start<TResult>(compiled, params as readonly unknown[]) as Promise<ProcessHandle<TResult, TExports>>;
  };

  const get = async (params: TParams): Promise<ProcessHandle<TResult, TExports> | null> => {
    const executor = getProcessExecutor();
    if (!executor) {
      throw new Error('No ProcessExecutor available.');
    }

    const instanceId = generateInstanceId(compiled.path, params as readonly unknown[]);
    const state = await executor.get(instanceId);

    if (!state) return null;

    return {
      id: instanceId,
      path: compiled.path,
      status: state.status,
      result: state.result as TResult | undefined,
      error: state.error ? new Error(state.error) : undefined,
      data: undefined as any,
      statusChanges: { async *[Symbol.asyncIterator]() {} },
      wait: () => Promise.resolve(state.result as TResult),
      cancel: () => executor.cancel(instanceId),
    };
  };

  const query = (
    pattern: Partial<Record<string, string>>
  ): AsyncIterable<ProcessHandle<TResult, TExports>> => {
    return {
      async *[Symbol.asyncIterator]() {
        const executor = getProcessExecutor();
        if (!executor) {
          throw new Error('No ProcessExecutor available.');
        }

        for await (const state of executor.queryByProcessId(compiled.id)) {
          // Filter by pattern: check if the instance identity matches all pattern keys
          const stateIdentity = state.vars.__identity as Record<string, string> | undefined;
          if (pattern && stateIdentity) {
            let matches = true;
            for (const [key, value] of Object.entries(pattern)) {
              if (stateIdentity[key] !== value) {
                matches = false;
                break;
              }
            }
            if (!matches) continue;
          }

          yield {
            id: state.instanceId,
            path: compiled.path,
            status: state.status,
            result: state.result as TResult | undefined,
            error: state.error ? new Error(state.error) : undefined,
            data: undefined as any,
            statusChanges: { async *[Symbol.asyncIterator]() {} },
            wait: () => Promise.resolve(state.result as TResult),
            cancel: () => executor.cancel(state.instanceId),
          };
        }
      },
    };
  };

  const emit = async (
    signal: string,
    identity: unknown[],
    payload?: unknown
  ): Promise<void> => {
    const executor = getProcessExecutor();
    if (!executor) {
      throw new Error('No ProcessExecutor available.');
    }

    const identityRecord = extractIdentity(compiled.path, identity);
    await executor.emit(signal, identityRecord, payload);
  };

  const definition = Object.assign(processCallable, {
    path: compiled.path as TPath,
    get,
    query,
    emit,
    exports: undefined,
    [COMPILED_PROCESS]: true,
    __compiled: compiled,
    deps: compiled.inject,
    factory: (_resolvedDeps: Record<string, unknown>) => processCallable,
  }) as ProcessDefinition<TPath, TParams, TResult, TExports>;

  return definition;
}

// ============================================================================
// Executor Context
// ============================================================================

/**
 * Per-async-context executor binding.
 *
 * A module-level mutable singleton would race under concurrent test execution
 * (or any multi-app process): test A's `setProcessExecutor(execA)` clobbers
 * test B's `setProcessExecutor(execB)` and B's compiled-process callsites get
 * A's executor.
 *
 * AsyncLocalStorage scopes the binding to the calling async context, so two
 * concurrent test contexts each see their own executor.
 *
 * Production code paths read from the DI container first (see
 * `getProcessExecutor` below), so the ALS path is mainly for tests and
 * non-DI bootstrap code.
 */
const executorStore = new AsyncLocalStorage<ProcessExecutor>();

/**
 * Process-wide fallback executor — used when neither the DI container nor
 * the ALS context resolves one. Set by code that lives outside any async
 * scope (rare; legacy bootstrap), and intentionally NOT updated when ALS
 * already has a value (so tests can't leak into production code).
 */
let fallbackExecutor: ProcessExecutor | null = null;

/**
 * All known compiled processes (never cleared).
 * Each new executor gets all processes registered when setProcessExecutor is called.
 * This supports multi-instance scenarios where multiple executors need the same process definitions.
 */
const allProcesses: CompiledSwitchProcess<Record<string, ServiceToken>>[] = [];

/**
 * Register a compiled process for resumption.
 * The process is added to the global list and registered with the current executor (if any).
 * All processes are also registered with any future executors via setProcessExecutor.
 */
export function registerCompiledProcess(compiled: CompiledSwitchProcess<Record<string, ServiceToken>>): void {
  const current = executorStore.getStore() ?? fallbackExecutor;
  if (!allProcesses.some(p => p.id === compiled.id)) {
    trace('registerCompiledProcess', { id: compiled.id, hasExecutor: !!current });
    allProcesses.push(compiled);
  }

  if (current) {
    current.register(compiled);
  }
}

/**
 * Bind a process executor to the current async context.
 *
 * When called inside an `als.run`/`enterWith` scope (e.g. a test's
 * beforeEach, an app's start path, withExecutor()), the binding lives only
 * in that async context — concurrent contexts are unaffected.
 *
 * When called outside any async scope (rare, legacy), it sets a process-wide
 * fallback so older bootstrap code keeps working.
 *
 * Pass `null` to clear: in an ALS scope this re-runs the parent context's
 * executor; outside any scope it clears the fallback.
 */
export function setProcessExecutor(executor: ProcessExecutor | null): void {
  trace('setProcessExecutor', { hasExecutor: !!executor, processCount: allProcesses.length });

  if (executor === null) {
    // `enterWith(undefined)` exits the current ALS frame; if we weren't in
    // one, also clear the fallback. We can't tell which "side" the caller
    // means, so clear both — null is a teardown signal.
    executorStore.enterWith(undefined as unknown as ProcessExecutor);
    fallbackExecutor = null;
    return;
  }

  // Bind to the current async context. enterWith propagates to subsequent
  // async ops launched from this context. Tests in concurrent contexts each
  // get their own binding.
  executorStore.enterWith(executor);

  // Also keep a fallback so callsites that escape the calling async context
  // (e.g. timers fired from a different scheduler thread) still find an
  // executor. Production deployments overwrite this once at boot; concurrent
  // test runs racing on this field is what the ALS path now obviates.
  fallbackExecutor = executor;

  for (const compiled of allProcesses) {
    trace('setProcessExecutor.register', { id: compiled.id });
    executor.register(compiled);
  }
}

/**
 * Get the current process executor.
 * Resolution order:
 *  1. DI container's AbstractProcessExecutor (if present) — proper multi-instance isolation
 *  2. AsyncLocalStorage scoped binding — set by `setProcessExecutor` / `withExecutor`
 *  3. Process-wide fallback — legacy bootstrap escape hatch
 */
export function getProcessExecutor(): ProcessExecutor | null {
  const container = getContainer();
  if (container) {
    const fromContainer = container.tryGetInstance(AbstractProcessExecutor);
    if (fromContainer) return fromContainer as ProcessExecutor;
  }

  return executorStore.getStore() ?? fallbackExecutor;
}

/**
 * Run a function with a specific executor context.
 *
 * Uses AsyncLocalStorage.run, so the binding is strictly scoped to `fn`
 * and any async ops it launches; nested calls and concurrent calls from
 * other contexts don't interfere. Falls back to the previous executor on
 * exit, no manual prev/restore.
 */
export async function withExecutor<T>(
  executor: ProcessExecutor,
  fn: () => T | Promise<T>
): Promise<T> {
  return executorStore.run(executor, fn);
}
