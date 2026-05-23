/**
 * Contextual Controllers
 *
 * Controllers that are invoked programmatically with caller-provided context,
 * rather than bound directly to a transport. Ideal for WebSocket, event-driven,
 * and similar scenarios where you need:
 *
 * 1. Multiple commands over a persistent connection
 * 2. Shared session context across command handlers
 * 3. Proper cleanup via Disposable
 *
 * @example
 * ```typescript
 * const RoomProcedures = createController
 *   .withContext<GameSession>()
 *   .create({
 *     inject: { rooms: RoomService },
 *     routes: (services) => ({
 *       join: Procedure('room/:roomId/join')
 *         .handle(({ session, params }) => {
 *           services.rooms.addPlayer(params.roomId, session.user)
 *           return { joined: params.roomId }
 *         })
 *     })
 *   })
 *
 * // In WebSocket handler
 * const ctrl = container.resolve(RoomProcedures)
 * using session = ctrl.createSession({ user, ws })
 * await session.run()
 * ```
 */

import type { z } from 'zod';
import type { Logger } from './service.js';
import type { Middleware, Guard } from './middleware.js';
import { type BuiltinContext } from './controller.js';

const TRACE_ENABLED = process.env.JUSTSCALE_TRACE === '1' || process.env.JUSTSCALE_TRACE === 'true';
function trace(message: string, data?: Record<string, unknown>): void {
  if (!TRACE_ENABLED) return;
  const timestamp = new Date().toISOString();
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  console.debug(`[${timestamp}] [TRACE] [ContextualController] ${message}${dataStr}`);
}

// ============================================================================
// Core Types
// ============================================================================

/**
 * A WebSocket-like interface that provides raw message stream.
 * Used by session.run() for automatic message loop handling.
 */
export interface RawMessageSource {
  /** Async iterator of raw messages */
  rawMessages(): AsyncIterable<string | Buffer>;
  /** Send a message */
  send(data: string | Buffer): void;
}

/**
 * Handler context for procedures.
 * Extends BuiltinContext with session context, params, body, and signal.
 */
export interface ProcedureHandlerContext<
  TSession,
  TParams = Record<string, string>,
  TBody = unknown,
> extends BuiltinContext {
  /** Session context (user, ws, etc.) */
  session: TSession;
  /** Path parameters extracted from procedure path */
  params: TParams;
  /** Request body (validated if schema provided) */
  body: TBody;
  /** AbortSignal for cancellation/timeout support */
  signal: AbortSignal;
}

/**
 * Options for session.run()
 */
export interface RunOptions {
  /** Custom message parser (default: JSON { command, payload }) */
  parse?: (raw: string | Buffer) => { command: string; payload: unknown };
  /** Custom response serializer (default: JSON.stringify) */
  serialize?: (result: unknown) => string | Buffer;
}

/**
 * Options for session creation
 */
export interface SessionOptions {
  /** Default timeout for all procedures (ms) */
  defaultTimeout?: number;
}

/**
 * Request status
 */
export type RequestStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

/**
 * A handle to an in-flight procedure request.
 * Enables waiting for results, streaming, and cancellation.
 */
export interface ProcedureRequest<T> {
  /** Wait for single result (or final result from generator) */
  join(): Promise<T>;

  /** Stream multiple results (for generator handlers) */
  subscribe(): AsyncGenerator<T>;

  /** Cancel execution (aborts signal, closes generator) */
  cancel(): void;

  /** Current request status */
  readonly status: RequestStatus;
}

/**
 * A session binding context to a contextual controller.
 * Implements Disposable for automatic cleanup.
 */
export interface Session<TSessionContext> extends Disposable {
  /** The bound context */
  readonly context: TSessionContext;

  /**
   * Invoke a procedure by command path.
   * Returns a request handle for waiting/streaming/cancelling.
   */
  invoke(command: string, payload: unknown): ProcedureRequest<unknown>;

  /**
   * Run the message loop (requires context to have a `ws` with rawMessages()).
   * Blocks until disconnect, tracks all requests.
   */
  run(options?: RunOptions): Promise<void>;

  /**
   * Register a cleanup callback.
   * Callbacks run on disposal in LIFO order.
   */
  onDispose(fn: () => void | Promise<void>): void;
}

/**
 * A resolved step - middleware or guard function ready for execution.
 */
export interface ResolvedStep {
  type: 'use' | 'guard';
  fn: Middleware<any, any> | Guard<any>;
}

/**
 * A compiled procedure ready for matching.
 */
export interface CompiledProcedure {
  /** Procedure name from the controller's routes object */
  name: string;
  /** Full path as string */
  path: string;
  /** Path segments */
  segments: string[];
  /** Compiled regex pattern */
  pattern: RegExp;
  /** Parameter names extracted from path */
  paramNames: string[];
  /** Body schema (if any) */
  schema?: z.ZodType;
  /** Resolved steps - middleware and guards in execution order */
  steps: ResolvedStep[];
  /** Handler function */
  handler: (ctx: any) => unknown | Promise<unknown>;
  /** Timeout in ms (if any) */
  timeout?: number;
}

/**
 * Runtime instance of a contextual controller.
 */
export interface ContextualControllerInstance<TSessionContext> {
  /** Compiled procedures */
  procedures: CompiledProcedure[];
  /** Create a new session with the given context */
  createSession(context: TSessionContext, options?: SessionOptions): Session<TSessionContext>;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when a procedure is not found.
 */
export class ProcedureNotFoundError extends Error {
  constructor(public readonly command: string) {
    super(`Procedure not found: ${command}`);
    this.name = 'ProcedureNotFoundError';
  }
}

/**
 * Error thrown when a guard denies access.
 */
export class GuardDeniedError extends Error {
  constructor(public readonly command: string) {
    super(`Access denied: ${command}`);
    this.name = 'GuardDeniedError';
  }
}

/**
 * Error thrown when a procedure times out.
 */
export class TimeoutError extends Error {
  constructor(public readonly command: string, public readonly timeoutMs: number) {
    super(`Procedure timed out after ${timeoutMs}ms: ${command}`);
    this.name = 'TimeoutError';
  }
}

/**
 * Error thrown when a request is cancelled.
 */
export class CancellationError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'CancellationError';
  }
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Check if a value is an async generator.
 */
function isAsyncGenerator(obj: unknown): obj is AsyncGenerator {
  return (
    obj != null &&
    typeof obj === 'object' &&
    Symbol.asyncIterator in obj &&
    typeof (obj as any).next === 'function' &&
    typeof (obj as any).return === 'function'
  );
}

/**
 * Implementation of ProcedureRequest with buffered streaming.
 */
class ProcedureRequestImpl<T> implements ProcedureRequest<T> {
  status: RequestStatus = 'pending';
  private abortController = new AbortController();
  private resultPromise: Promise<T>;
  private generator?: AsyncGenerator<T>;
  private resolveResult!: (value: T) => void;
  private rejectResult!: (error: Error) => void;

  // Buffered values for subscribe()
  private valueBuffer: T[] = [];
  private waiters: Array<() => void> = [];
  private streamDone = false;
  private streamError?: Error;

  // Track whether handler is a generator (undefined until determined)
  private isGeneratorHandler?: boolean;
  private handlerTypeWaiters: Array<() => void> = [];


  constructor(
    private procedure: CompiledProcedure,
    private payload: unknown,
    private sessionContext: unknown,
    private createLogger: (context: string) => Logger,
    private defaultTimeout?: number,
    private routesProxy: Record<string, unknown> = {},
  ) {
    this.resultPromise = new Promise<T>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });

    // Start execution immediately (fire-and-forget pattern)
    this.execute().catch((err) => {
      this.status = 'failed';
      this.rejectResult(err);
    });
  }

  private pushValue(value: T): void {
    this.valueBuffer.push(value);
    // Wake up any waiting subscribers
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters = [];
  }

  private finishStream(error?: Error): void {
    this.streamDone = true;
    this.streamError = error;
    // Wake up any waiting subscribers
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters = [];
  }

  private setHandlerType(isGenerator: boolean): void {
    this.isGeneratorHandler = isGenerator;
    // Wake up any waiting for handler type
    for (const waiter of this.handlerTypeWaiters) {
      waiter();
    }
    this.handlerTypeWaiters = [];
  }

  private async waitForHandlerType(): Promise<boolean> {
    if (this.isGeneratorHandler !== undefined) {
      return this.isGeneratorHandler;
    }
    await new Promise<void>((resolve) => {
      this.handlerTypeWaiters.push(resolve);
    });
    return this.isGeneratorHandler!;
  }

  private async execute(): Promise<void> {
    const { procedure, payload, sessionContext, abortController } = this;
    trace('execute', { procedureName: procedure.name, path: procedure.path });

    // Setup timeout if configured
    const timeoutMs = procedure.timeout ?? this.defaultTimeout;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timeoutId = setTimeout(() => {
        this.status = 'cancelled';
        abortController.abort();
        this.rejectResult(new TimeoutError(procedure.path, timeoutMs));
      }, timeoutMs);
    }

    try {
      // Extract params from path
      const match = procedure.pattern.exec(procedure.path);
      const params: Record<string, string> = {};
      if (match) {
        procedure.paramNames.forEach((name, i) => {
          params[name] = match[i + 1];
        });
      }

      // Build handler context
      const logger = this.createLogger(procedure.name);
      let ctx: Record<string, unknown> = {
        session: sessionContext,
        params,
        body: payload,
        signal: abortController.signal,
        logger,
      };

      // Run steps (middleware and guards in order)
      for (const step of procedure.steps) {
        if (abortController.signal.aborted) {
          throw new Error('Request cancelled');
        }
        if (step.type === 'use') {
          const additions = await step.fn(ctx);
          ctx = { ...ctx, ...additions };
        } else {
          const allowed = await step.fn(ctx);
          if (!allowed) {
            throw new GuardDeniedError(procedure.path);
          }
        }
      }

      // Validate body if schema provided
      if (procedure.schema) {
        const parsed = procedure.schema.parse(payload);
        ctx.body = parsed;
      }

      // Execute handler with `this` bound to routes proxy for sibling access
      trace('execute.handler', { procedureName: procedure.name, hasSchema: !!procedure.schema, bodyType: typeof ctx.body });
      const result = await procedure.handler.call(this.routesProxy, ctx);
      trace('execute.handler.complete', { procedureName: procedure.name, isGenerator: isAsyncGenerator(result) });

      // Handle generator vs regular return
      if (isAsyncGenerator(result)) {
        this.generator = result as AsyncGenerator<T>;
        this.setHandlerType(true);

        // Consume generator, buffer values for subscribe(), track last value
        let lastValue: T | undefined;
        try {
          for await (const value of this.generator) {
            if (abortController.signal.aborted) {
              break;
            }
            this.pushValue(value);
            lastValue = value;
          }
          this.status = 'completed';
          this.finishStream();
          this.resolveResult(lastValue as T);
        } catch (err) {
          this.status = 'failed';
          this.finishStream(err as Error);
          this.rejectResult(err as Error);
        }
      } else {
        this.setHandlerType(false);
        this.status = 'completed';
        this.finishStream();
        this.resolveResult(result as T);
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  join(): Promise<T> {
    return this.resultPromise;
  }

  async *subscribe(): AsyncGenerator<T> {
    // Wait until we know if this is a generator handler
    const isGenerator = await this.waitForHandlerType();

    if (!isGenerator) {
      // Not a generator handler - just yield the single result
      yield await this.resultPromise;
      return;
    }

    // Read from the buffer, waiting for new values as needed
    let index = 0;
    while (true) {
      // Yield any buffered values
      while (index < this.valueBuffer.length) {
        yield this.valueBuffer[index++];
      }

      // Check if stream is done
      if (this.streamDone) {
        if (this.streamError) {
          throw this.streamError;
        }
        return;
      }

      // Wait for more values
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  cancel(): void {
    if (this.status !== 'pending') return;

    this.status = 'cancelled';
    this.abortController.abort();

    const error = new CancellationError();
    this.finishStream(error);
    this.rejectResult(error);
  }
}

/**
 * Implementation of Session.
 */
class SessionImpl<TSessionContext> implements Session<TSessionContext> {
  private disposeCallbacks: Array<() => void | Promise<void>> = [];
  private pendingRequests = new Set<ProcedureRequestImpl<unknown>>();
  private streamingTasks = new Set<Promise<void>>();
  private disposed = false;

  constructor(
    readonly context: TSessionContext,
    private procedures: CompiledProcedure[],
    private createLogger: (context: string) => Logger,
    private options: SessionOptions = {},
    private routesProxy: Record<string, unknown> = {}
  ) {}

  invoke(command: string, payload: unknown): ProcedureRequest<unknown> {
    trace('invoke', { command, hasPayload: payload !== undefined });
    if (this.disposed) {
      throw new Error('Session is disposed');
    }

    // Match command to procedure
    const matched = this.matchProcedure(command);
    trace('invoke.matched', { command, found: !!matched, procedureName: matched?.procedure.name });
    if (!matched) {
      // Return a failed request
      const req = {
        status: 'failed' as RequestStatus,
        join: () => Promise.reject(new ProcedureNotFoundError(command)),
        subscribe: async function*() {
          throw new ProcedureNotFoundError(command);
        },
        cancel: () => {},
      };
      return req;
    }

    const request = new ProcedureRequestImpl(
      matched.procedure,
      payload,
      this.context,
      this.createLogger,
      this.options.defaultTimeout,
      this.routesProxy,
    );

    this.pendingRequests.add(request);

    // Remove from pending when done (suppress cancellation errors)
    request.join()
      .catch(() => {}) // Expected when cancelled
      .finally(() => {
        this.pendingRequests.delete(request);
      });

    return request;
  }

  private matchProcedure(command: string): { procedure: CompiledProcedure; params: Record<string, string> } | null {
    for (const procedure of this.procedures) {
      const match = procedure.pattern.exec(command);
      if (match) {
        const params: Record<string, string> = {};
        procedure.paramNames.forEach((name, i) => {
          params[name] = match[i + 1];
        });
        return { procedure: { ...procedure, path: command }, params };
      }
    }
    return null;
  }

  async run(options?: RunOptions): Promise<void> {
    const ws = (this.context as any).ws as RawMessageSource | undefined;
    if (!ws?.rawMessages) {
      throw new Error('Session context must have ws with rawMessages() for run()');
    }

    const parse = options?.parse ?? ((raw: string | Buffer) => {
      const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
      return JSON.parse(str) as { command: string; payload: unknown };
    });
    const serialize = options?.serialize ?? ((result: unknown) => JSON.stringify(result));

    for await (const raw of ws.rawMessages()) {
      if (this.disposed) break;

      try {
        const { command, payload } = parse(raw);
        trace('run.message', { command, hasPayload: payload !== undefined });
        const request = this.invoke(command, payload);

        // Stream values back to the client - track the task for cleanup
        const streamTask = (async () => {
          try {
            for await (const value of request.subscribe()) {
              if (this.disposed) break;
              if (value !== undefined) {
                ws.send(serialize(value));
              }
            }
          } catch (err) {
            // Ignore cancellation errors, only send real errors if not disposed
            if (!(err instanceof CancellationError) && !this.disposed) {
              ws.send(serialize({ error: (err as Error).message, command }));
            }
          }
        })();

        this.streamingTasks.add(streamTask);
        streamTask.finally(() => this.streamingTasks.delete(streamTask));
      } catch (err) {
        // Parse error - send error response
        ws.send(serialize({ error: (err as Error).message }));
      }
    }
  }

  onDispose(fn: () => void | Promise<void>): void {
    this.disposeCallbacks.push(fn);
  }

  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;

    // Run dispose callbacks FIRST (in LIFO order) - this disposes subscriptions
    // which causes for-await loops to exit naturally via { done: true }
    for (let i = this.disposeCallbacks.length - 1; i >= 0; i--) {
      try {
        const result = this.disposeCallbacks[i]();
        if (result instanceof Promise) {
          result.catch(() => {}); // Swallow errors in async cleanup
        }
      } catch {
        // Swallow errors in cleanup
      }
    }

    // Then cancel pending requests (loops should have exited by now)
    for (const request of this.pendingRequests) {
      request.cancel();
    }
    this.pendingRequests.clear();
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a contextual controller instance from compiled procedures.
 * This is called by the withContext() factory.
 */
export function createContextualControllerInstance<TSessionContext>(
  procedures: CompiledProcedure[],
  createLogger: (context: string) => Logger,
  routesProxy: Record<string, unknown> = {}
): ContextualControllerInstance<TSessionContext> {
  return {
    procedures,
    createSession(context: TSessionContext, options?: SessionOptions): Session<TSessionContext> {
      return new SessionImpl(context, procedures, createLogger, options, routesProxy);
    },
  };
}
