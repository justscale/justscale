/**
 * @justscale/process - Process Factory
 *
 * Creates durable process definitions that are transformed by the compiler
 * into opcode-based execution graphs.
 */

import type { ServiceToken } from '../core/index.js';
import type {
  ExtractPathParams,
  ProcessConfig,
  ProcessDefinition,
  ProcessHandle,
} from './types.js';

/**
 * Symbol marking a process definition for compiler detection.
 * The compiler uses this to identify and transform process handlers.
 */
// Cross-realm: tests forge these via Symbol.for() and the compiler emits
// references in user code. Keep interned so identity matches across module
// instances and across the test/runtime boundary.
export const PROCESS_DEFINITION = Symbol.for('justscale:processDefinition');
export const SUBPROCESS_DEFINITION = Symbol.for('justscale:subprocessDefinition');

/**
 * Creates a durable process definition.
 *
 * Process definitions are compiled by the JustScale compiler into opcode-based
 * execution graphs that support:
 * - Durable execution across restarts
 * - Signal-based suspension and resumption
 * - Transactional state persistence
 * - Race conditions between signals and timers
 *
 * The runtime stub returned by this function throws at runtime - the actual
 * implementation is injected by the compiler transform.
 *
 * @example
 * ```typescript
 * import { createProcess } from '@justscale/process'
 *
 * const OrderFulfillment = createProcess({
 *   path: '/order/:orderId/fulfillment',
 *   inject: { payments: PaymentService, shipping: ShippingService },
 *   async handler({ payments, shipping }, [orderId]) {
 *     // Suspend until payment is received
 *     const payment = await payments.received(orderId)
 *
 *     // Continue with shipping
 *     await shipping.dispatch(orderId, payment.address)
 *
 *     return { status: 'fulfilled' }
 *   },
 * })
 *
 * // Start a process instance
 * const handle = await OrderFulfillment(['order-123'])
 * ```
 *
 * @param config - Process configuration including path, dependencies, and handler
 * @returns A process definition that can start and query process instances
 */
export function createProcess<
  TPath extends string,
  TDeps extends Record<string, ServiceToken>,
  TResult,
  TExports = void,
  TTypes extends Record<string, import('./types.js').ModelClass> = {},
>(
  config: ProcessConfig<TPath, TDeps, TResult, TExports, TTypes>
): ProcessDefinition<TPath, ExtractPathParams<TPath>, TResult, TExports> {
  type TParams = ExtractPathParams<TPath>;

  const storedConfig = config;

  const processCallable = async (_params: TParams): Promise<ProcessHandle<TResult, TExports>> => {
    throw new Error(
      `Process "${config.path}" not compiled. ` +
      'Run the JustScale compiler to transform process definitions into executable opcodes.'
    );
  };

  const get = async (_params: TParams): Promise<ProcessHandle<TResult, TExports> | null> => {
    throw new Error(
      `Process "${config.path}" not compiled. ` +
      'The get() method requires the compiler transform to be applied.'
    );
  };

  const query = (_pattern: Partial<Record<string, string>>): AsyncIterable<ProcessHandle<TResult, TExports>> => {
    return {
      [Symbol.asyncIterator](): AsyncIterator<ProcessHandle<TResult, TExports>> {
        return {
          async next(): Promise<IteratorResult<ProcessHandle<TResult, TExports>>> {
            throw new Error(
              `Process "${config.path}" not compiled. ` +
              'The query() method requires the compiler transform to be applied.'
            );
          }
        };
      }
    };
  };

  /**
   * Emit a signal to processes waiting for it.
   * @deprecated Use service methods instead. Provided for testing.
   */
  const emit = async (
    _signal: string,
    _identity: unknown[],
    _payload: unknown
  ): Promise<void> => {
    throw new Error(
      `Process "${config.path}" not compiled. ` +
      'The emit() method requires the compiler transform to be applied.'
    );
  };

  const definition = Object.assign(processCallable, {
    path: config.path,
    get,
    query,
    emit,
    exports: undefined,
    [PROCESS_DEFINITION]: true,
    __config: storedConfig,
    deps: config.inject,
    factory: (_resolvedDeps: Record<string, unknown>) => processCallable,
  }) as ProcessDefinition<TPath, TParams, TResult, TExports>;

  return definition;
}

export interface SubProcessConfig<THandler extends (...args: any[]) => Promise<any> = (...args: any[]) => Promise<unknown>> {
  name: string
  path: string
  handler: THandler
}

/**
 * Declares a named subprocess inside a process handler.
 * The compiler transforms this into nested state within the parent process.
 * At runtime, the returned callable spawns subprocess instances.
 */
export function createSubProcess<THandler extends (...args: any[]) => Promise<any>>(
  config: SubProcessConfig<THandler>
): THandler & { [SUBPROCESS_DEFINITION]: true } {
  const callable = (..._args: unknown[]): Promise<unknown> => {
    throw new Error(
      `createSubProcess("${config.name}") not compiled. ` +
      'Run the JustScale compiler to transform subprocess definitions.'
    );
  };
  (callable as any)[SUBPROCESS_DEFINITION] = true;
  (callable as any).__config = config;
  return callable as any;
}
