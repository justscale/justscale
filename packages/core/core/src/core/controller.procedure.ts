/**
 * Procedure Route Builder
 *
 * Route builder for contextual controllers. Similar to HTTP's Get/Post builders
 * but for programmatic invocation with session context.
 *
 * @example
 * ```typescript
 * Procedure('room/:roomId/bet')
 *   .body(z.object({ amount: z.number() }))
 *   .use(fetchRoom)
 *   .guard(hasPermission)
 *   .timeout(30000)
 *   .handle(({ session, params, body, room }) => {
 *     // session.user, session.ws from context
 *     // params.roomId from path
 *     // body.amount from payload
 *     // room from middleware
 *     return { accepted: true }
 *   })
 * ```
 */

import type { z } from 'zod';
import type {
  ExtractParams,
  Prettify,
} from './plugin.js';
import type {
  Middleware,
  Guard,
  MiddlewareDef,
  GuardDef,
  UnresolvedMiddleware,
  UnresolvedGuard,
} from './middleware.js';
import type { BuiltinContext } from './controller.js';

// ============================================================================
// Module Augmentation - Procedure Transport
// ============================================================================

declare module '@justscale/core' {
  interface SupportedMethods {
    PROCEDURE: { transport: 'procedure'; hasBody: true; idempotent: false };
  }
}

// ============================================================================
// Symbols for metadata storage
// ============================================================================

export const PROCEDURE_TIMEOUT = Symbol('@justscale/procedure-timeout');
export const PROCEDURE_THROWS = Symbol('@justscale/procedure-throws');
export const PROCEDURE_BODY_SCHEMA = Symbol('@justscale/procedure-body-schema');
export const PROCEDURE_RESPONSE_SCHEMA = Symbol('@justscale/procedure-response-schema');

// ============================================================================
// Types
// ============================================================================

/**
 * Base procedure context before middleware.
 * TSession is the session context type from createContextualController<T>().
 */
export interface ProcedureContext<
  TSession = unknown,
  TParams = Record<string, string>,
  TBody = unknown
> extends BuiltinContext {
  /** Session context (user, ws, etc.) */
  session: TSession;
  /** Path parameters */
  params: Prettify<TParams>;
  /** Request body (validated if schema provided) */
  body: TBody;
  /** AbortSignal for cancellation */
  signal: AbortSignal;
}

/**
 * Extract middleware added type.
 */
type ExtractMiddlewareAdded<T> =
  T extends { factory: (deps: any) => Middleware<any, infer A> } ? A :
    T extends Middleware<any, infer A> ? A :
      Record<string, unknown>;

/** Procedure route definition. */
export interface ProcedureDef<
  TPath extends string = string,
  TBody = unknown,
  TResponse = unknown
> {
  /** Route method - always 'PROCEDURE' for procedures */
  method: 'PROCEDURE';
  /** Route path with optional params */
  path: TPath;
  /** Body schema for validation */
  schema?: z.ZodType;
  /** Unresolved steps - middleware and guards that may need DI resolution */
  steps: UnresolvedStep[];
  /** Handler function */
  handler: (ctx: any) => TResponse | Promise<TResponse>;
  /** Timeout in milliseconds */
  [PROCEDURE_TIMEOUT]?: number;
  /** Error types that can be thrown */
  [PROCEDURE_THROWS]?: Array<new (...args: any[]) => Error>;
}

/**
 * Procedure route builder interface.
 * Accumulates middleware context and configuration through the chain.
 */
export interface ProcedureBuilder<
  TSession,
  TParams,
  TContext,
  TBody = unknown,
  TResponse = unknown,
  TPath extends string = string
> {
  /**
   * Specify the body/payload schema.
   * Validates incoming payload and types the body in the handler context.
   */
  body<T>(schema: z.ZodType<T>): ProcedureBuilder<
    TSession,
    TParams,
    Prettify<Omit<TContext, 'body'> & { body: T }>,
    T,
    TResponse,
    TPath
  >;

  /**
   * Add middleware that extends the context.
   */
  use<TAdded extends object>(
    middleware: (ctx: TContext) => TAdded | Promise<TAdded>
  ): ProcedureBuilder<
    TSession,
    TParams,
    Prettify<TContext & TAdded>,
    TBody,
    TResponse,
    TPath
  >;

  /**
   * Add a middleware definition (with DI support).
   */
  use<TMiddleware extends MiddlewareDef<any, any>>(
    middleware: TMiddleware
  ): ProcedureBuilder<
    TSession,
    TParams,
    Prettify<TContext & ExtractMiddlewareAdded<TMiddleware>>,
    TBody,
    TResponse,
    TPath
  >;

  /**
   * Add a guard that gates access to the procedure.
   */
  guard(check: Guard<TContext> | GuardDef<any>): ProcedureBuilder<
    TSession,
    TParams,
    TContext,
    TBody,
    TResponse,
    TPath
  >;

  /**
   * Set a timeout for this procedure.
   * If the handler doesn't complete within the timeout, the request is cancelled.
   */
  timeout(ms: number): ProcedureBuilder<TSession, TParams, TContext, TBody, TResponse, TPath>;

  /**
   * Declare error types that this procedure can throw.
   * Useful for documentation and typed error handling.
   */
  throws<TErrors extends Array<new (...args: any[]) => Error>>(
    ...errors: TErrors
  ): ProcedureBuilder<TSession, TParams, TContext, TBody, TResponse, TPath>;

  /**
   * Specify the response schema for documentation.
   */
  returns<T>(schema: z.ZodType<T>): ProcedureBuilder<TSession, TParams, TContext, TBody, T, TPath>;

  /**
   * Set the handler for this procedure.
   * Can return a value (single response) or be an async generator (streaming).
   */
  handle(
    handler: (ctx: TContext) => TResponse | Promise<TResponse>
  ): ProcedureDef<TPath, TBody, TResponse>;

  /**
   * Set an async generator handler for streaming responses.
   */
  handle(
    handler: (ctx: TContext) => AsyncGenerator<TResponse>
  ): ProcedureDef<TPath, TBody, TResponse>;
}

/**
 * An unresolved step - middleware or guard that may need DI resolution.
 */
export interface UnresolvedStep {
  type: 'use' | 'guard';
  fn: UnresolvedMiddleware | UnresolvedGuard;
}

/**
 * Internal builder state.
 */
interface BuilderState {
  path: string;
  bodySchema?: z.ZodType;
  responseSchema?: z.ZodType;
  steps: UnresolvedStep[];
  timeoutMs?: number;
  errorTypes: Array<new (...args: any[]) => Error>;
}

/** @internal Loose-typed builder for internal use; cast to ProcedureBuilder at the boundary. */
interface BuilderImpl {
  body(schema: z.ZodType): BuilderImpl;
  use(middleware: UnresolvedMiddleware): BuilderImpl;
  guard(check: UnresolvedGuard): BuilderImpl;
  timeout(ms: number): BuilderImpl;
  throws(...errors: Array<new (...args: any[]) => Error>): BuilderImpl;
  returns(schema: z.ZodType): BuilderImpl;
  handle(handler: (ctx: any) => any): ProcedureDef<any, any, any>;
}

/**
 * Create a procedure builder.
 */
function createProcedureBuilder<TSession, TPath extends string>(
  path: TPath,
  state: BuilderState
): ProcedureBuilder<TSession, ExtractParams<TPath>, ProcedureContext<TSession, ExtractParams<TPath>>, unknown, unknown, TPath> {
  const builder: BuilderImpl = {
    body(schema: z.ZodType) {
      return createProcedureBuilder(path, { ...state, bodySchema: schema }) as unknown as BuilderImpl;
    },

    use(middleware: UnresolvedMiddleware) {
      return createProcedureBuilder(path, {
        ...state,
        steps: [...state.steps, { type: 'use', fn: middleware }],
      }) as unknown as BuilderImpl;
    },

    guard(check: UnresolvedGuard) {
      return createProcedureBuilder(path, {
        ...state,
        steps: [...state.steps, { type: 'guard', fn: check }],
      }) as unknown as BuilderImpl;
    },

    timeout(ms: number) {
      return createProcedureBuilder(path, { ...state, timeoutMs: ms }) as unknown as BuilderImpl;
    },

    throws(...errors: Array<new (...args: any[]) => Error>) {
      return createProcedureBuilder(path, {
        ...state,
        errorTypes: [...state.errorTypes, ...errors],
      }) as unknown as BuilderImpl;
    },

    returns(schema: z.ZodType) {
      return createProcedureBuilder(path, { ...state, responseSchema: schema }) as unknown as BuilderImpl;
    },

    handle(handler: (ctx: any) => any): ProcedureDef<any, any, any> {
      const def: ProcedureDef<any, any, any> = {
        method: 'PROCEDURE',
        path,
        schema: state.bodySchema,
        steps: [...state.steps],
        handler,
      };

      if (state.timeoutMs !== undefined) {
        (def as any)[PROCEDURE_TIMEOUT] = state.timeoutMs;
      }
      if (state.errorTypes.length > 0) {
        (def as any)[PROCEDURE_THROWS] = state.errorTypes;
      }
      if (state.bodySchema) {
        (def as any)[PROCEDURE_BODY_SCHEMA] = state.bodySchema;
      }
      if (state.responseSchema) {
        (def as any)[PROCEDURE_RESPONSE_SCHEMA] = state.responseSchema;
      }

      return def;
    },
  };

  return builder as unknown as ProcedureBuilder<TSession, ExtractParams<TPath>, ProcedureContext<TSession, ExtractParams<TPath>>, unknown, unknown, TPath>;
}

/**
 * Create a procedure route.
 *
 * @example
 * ```typescript
 * Procedure('room/:roomId/join')
 *   .handle(({ session, params }) => {
 *     return { joined: params.roomId }
 *   })
 * ```
 */
export function Procedure<TPath extends string>(
  path: TPath
): ProcedureBuilder<unknown, ExtractParams<TPath>, ProcedureContext<unknown, ExtractParams<TPath>>, unknown, unknown, TPath> {
  return createProcedureBuilder(path, {
    path,
    steps: [],
    errorTypes: [],
  });
}

/** @internal Used by createContextualController(). */
export function createProcedureFactory<TSession>() {
  return function BoundProcedure<TPath extends string>(
    path: TPath
  ): ProcedureBuilder<TSession, ExtractParams<TPath>, ProcedureContext<TSession, ExtractParams<TPath>>, unknown, unknown, TPath> {
    return createProcedureBuilder<TSession, TPath>(path, {
      path,
      steps: [],
      errorTypes: [],
    });
  };
}
