import type {
  BuilderPlugin,
  GuardDef,
  MiddlewareDef,
  ResponseEntry,
  RouteDefV2 as RouteDef,
  Stop,
} from '@justscale/core';
import type { ExtractParams, TypedParams } from '@justscale/core/models';
import type { z } from 'zod';
import type {
  ReplaceRes,
  ReplaceResPermissionAware,
  HasPermissionReturns,
} from '../types.js';

type ReturnsToResponseMap<T> =
  T extends ResponseEntry<infer S, infer B>
    ? { [K in S]: B }
    : {};

type UnionToIntersection<U> =
  (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

export type BuildResponseMap<TReturns> = [TReturns] extends [never]
  ? Record<number, unknown>
  : UnionToIntersection<ReturnsToResponseMap<TReturns>> extends infer R
    ? { [K in keyof R]: R[K] }
    : Record<number, unknown>;

type HandlerContext<TContext, TReturns> = [TReturns] extends [never]
  ? TContext
  : HasPermissionReturns<TReturns> extends true
    ? ReplaceResPermissionAware<TContext, TReturns>
    : ReplaceRes<TContext, BuildResponseMap<TReturns>>;

/**
 * HTTP-specific base context provided by the protocol.
 * This is what the server injects before route execution.
 */
export interface HttpBaseContext<TPath extends string> {
  req: {
    method: string
    url: string
    headers: Record<string, string | string[] | undefined>
    /** Underlying TCP socket. Present on real Node IncomingMessage —
     * required for trusted-proxy IP resolution (`getClientIp`). */
    socket: { remoteAddress?: string }
  }
  res: {
    status(code: number): { json(data: unknown): void; end(): void }
    json(data: unknown): void
    /** Send an HTML response with `text/html; charset=utf-8`. */
    html(content: string): void
  }
  params: ExtractParams<TPath>
  rawBody: unknown
  rawQuery: Record<string, string>
  /** Flattened request headers (lowercase keys) */
  headers: Record<string, string>
}

/**
 * HTTP Route Builder - extends core RouteBuilder with HTTP-specific methods.
 *
 * @typeParam TContext - Accumulated context from middleware
 * @typeParam TReturns - Union of possible responses (ResponseEntry union)
 * @typeParam TRequirements - Accumulated DI requirements from plugins
 * @typeParam TPath - Route path literal for param extraction
 * @typeParam TBody - Request body type (accumulated via body() calls)
 * @typeParam TParamTypes - Model classes for path params (set via .types())
 */
export interface HttpRouteBuilder<
  TContext,
  TReturns,
  TRequirements,
  TPath extends string,
  TBody = unknown,
  TParamTypes extends Record<string, abstract new (...args: any[]) => any> = {},
> {
  /**
   * Add middleware that extends context.
   * Cannot stop execution - always returns additions.
   * Accepts either a plain function or a MiddlewareDef (with DI injection).
   */
  use<TAdded extends object>(
    middleware: ((ctx: TContext) => TAdded | Promise<TAdded>) | MiddlewareDef<TAdded, any>,
  ): HttpRouteBuilder<TContext & TAdded, TReturns, TRequirements, TPath, TBody, TParamTypes>

  /**
   * Add guard that can stop execution.
   * Cannot add to context - only checks and potentially stops.
   * Accepts a guard function, a GuardDef (with DI), or an array of GuardDefs (any match = allow).
   */
  guard(
    check:
      | ((ctx: TContext & { stop(): Stop }) => void | Stop | boolean | Promise<void | Stop | boolean>)
      | GuardDef
      | readonly GuardDef[],
  ): HttpRouteBuilder<TContext, TReturns, TRequirements, TPath, TBody, TParamTypes>

  /**
   * Apply a plugin that can chain multiple operations.
   * Plugins can add use/guard/returns in any combination.
   */
  apply<TCtxOut, TRetOut, TReqOut, TBodyOut = TBody>(
    plugin: BuilderPlugin<
      TContext,
      TCtxOut,
      TReturns,
      TRetOut,
      TRequirements,
      TReqOut,
      TPath,
      TBody,
      TBodyOut
    >,
  ): HttpRouteBuilder<TCtxOut, TRetOut, TReqOut, TPath, TBodyOut, TParamTypes>

  /**
   * Declare a permission-scoped response.
   *
   * Multiple `.returns()` calls with the same status and different permissions
   * build a discriminated union on `res.permission` - the handler branches via
   * `switch(res.permission)` and TypeScript narrows `res.json()` per case.
   *
   * Requires `.use(permissions)` middleware to set `res.permission` at runtime.
   */
  returns<
    TStatus extends number,
    TSchema extends z.ZodType,
    TPermission extends import('@justscale/core').PermissionDefLike,
  >(
    status: TStatus,
    schema: TSchema,
    permission: TPermission,
  ): HttpRouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, z.infer<TSchema>, TPermission>,
    TRequirements,
    TPath,
    TBody,
    TParamTypes
  >

  /**
   * Declare a possible response with schema.
   */
  returns<TStatus extends number, TSchema extends z.ZodType>(
    status: TStatus,
    schema: TSchema,
  ): HttpRouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, z.infer<TSchema>>,
    TRequirements,
    TPath,
    TBody,
    TParamTypes
  >

  /**
   * Declare a possible response without body.
   */
  returns<TStatus extends number>(
    status: TStatus,
  ): HttpRouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, void>,
    TRequirements,
    TPath,
    TBody,
    TParamTypes
  >

  /**
   * Declare model types for path params.
   * Transforms matching params from `string` to `Reference<T>`.
   *
   * @example
   * ```typescript
   * Get('/:productRef')
   *   .types({ Product })
   *   .handle(({ params }) => {
   *     params.productRef  // Reference<Product>
   *   })
   * ```
   */
  types<TTypes extends Record<string, abstract new (...args: any[]) => any>>(
    types: TTypes,
  ): HttpRouteBuilder<
    Omit<TContext, 'params'> & { params: TypedParams<TPath, TTypes> },
    TReturns,
    TRequirements,
    TPath,
    TBody,
    TTypes
  >

  /**
   * Validate and parse query parameters.
   * Adds typed `query` to context.
   *
   * @example
   * ```typescript
   * Get('/users')
   *   .query(z.object({ page: z.string(), limit: z.string() }))
   *   .handle(({ query }) => {
   *     // query is typed as { page: string, limit: string }
   *   })
   * ```
   */
  query<TSchema extends z.ZodType>(
    schema: TSchema,
  ): HttpRouteBuilder<
    TContext & { query: z.infer<TSchema> },
    TReturns,
    TRequirements,
    TPath,
    TBody,
    TParamTypes
  >

  /**
   * Validate and parse request body.
   * Adds typed `body` to context.
   *
   * @example
   * ```typescript
   * Post('/users')
   *   .body(z.object({ name: z.string(), email: z.string() }))
   *   .handle(({ body }) => {
   *     // body is typed as { name: string, email: string }
   *   })
   * ```
   */
  body<TSchema extends z.ZodType>(
    schema: TSchema,
  ): HttpRouteBuilder<
    TContext & { body: z.infer<TSchema> },
    TReturns,
    TRequirements,
    TPath,
    z.infer<TSchema>,
    TParamTypes
  >

  /**
   * Set final handler.
   * When .returns() has been called, `res` is replaced with a typed version
   * that checks `res.json(data)` and `res.status(code).json(data)` against declared schemas.
   */
  handle(
    handler: (ctx: HandlerContext<TContext, TReturns>) => void | Promise<void>,
  ): HttpRouteDef<TPath, TReturns, TRequirements, TBody, TParamTypes>
}

/**
 * HTTP-specific route definition. Extends core RouteDef with HTTP method.
 * `__transportRequires` is read by core's `RequiresOf<ControllerDef>` aggregation.
 */
export interface HttpRouteDef<
  TPath extends string,
  TReturns,
  TRequirements,
  TBody = unknown,
  TParamTypes extends Record<string, abstract new (...args: any[]) => any> = {},
> extends RouteDef<TPath, TReturns, TRequirements, TBody> {
  method: HttpMethod
  readonly __transportRequires: typeof import('../adapter.js').HTTP_TRANSPORT_REQUIRES
  /** Phantom property for type extraction - never set at runtime */
  readonly _types?: {
    readonly returns: TReturns
    readonly body: TBody
    readonly requirements: TRequirements
    readonly paramTypes: TParamTypes
  }
}

/**
 * HTTP methods supported by the HTTP protocol.
 */
export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';
