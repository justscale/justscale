/**
 * SSE Route Factory
 *
 * Builder pattern for SSE routes — extends core RouteBuilder with
 * SSE-specific handler return type (async generator).
 *
 * @example
 * ```typescript
 * SSE('/:roomId/events')
 *   .types({ Room })
 *   .use(authMiddleware)
 *   .guard(isSubscriber)
 *   .handle(async function* ({ params }) {
 *     yield { event: 'hello', data: { message: 'connected' } }
 *   })
 * ```
 */

import {
  createBuilderState,
  createBaseBuilder,
  query as queryPlugin,
  registerOpenApiMethod,
} from '@justscale/core';

// SSE surfaces in OpenAPI as a GET with `text/event-stream` response —
// the standard OpenAPI 3.1 way to document server-sent events. The
// generator reads this registration and emits the right content type.
registerOpenApiMethod('SSE', {
  httpMethod: 'get',
  responseContentType: 'text/event-stream',
});
import type {
  ExtractAddedFromMiddleware,
  ExtractStepDeps,
  GuardDef,
  MiddlewareDef,
  ResponseEntry,
  RouteBuilderV2 as RouteBuilder,
  ServiceToken,
  Stop,
} from '@justscale/core';
import type { ExtractParams, TypedParams } from '@justscale/core/models';
import type { SSEContext, SSEEvent } from './types.js';

// Import types to ensure SupportedMethods augmentation is applied
import './types.js';

/** SSE handler return type — async generator yielding events */
type SSEHandlerReturn = AsyncGenerator<SSEEvent, void, undefined>;

/**
 * SSE route definition — extends the core RouteDef shape
 * so it's assignable to AnyRouteDef in createController.
 */
export interface SSERouteDef<TPath extends string = string> {
  method: 'SSE'
  path: TPath
  steps: Array<{ type: 'use' | 'guard'; fn: (ctx: any) => any }>
  handler: (ctx: any) => any
  responseSchemas: Map<number, import('zod').ZodType | null>
  types?: Record<string, abstract new (...args: any[]) => any>
}

/**
 * SSE route builder — extends core RouteBuilder with SSE handler type and .types().
 */
export interface SSERouteBuilder<
  TContext,
  TReturns,
  TRequirements,
  TPath extends string,
> extends RouteBuilder<TContext, TReturns, TRequirements, TPath, unknown, SSEHandlerReturn> {
  use<
    TMw extends
      | ((ctx: TContext) => object | Promise<object>)
      | MiddlewareDef<object, any>,
  >(
    middleware: TMw,
  ): SSERouteBuilder<
    TContext & ExtractAddedFromMiddleware<TMw>,
    TReturns,
    TRequirements | ExtractStepDeps<TMw>,
    TPath
  >

  guard<
    TG extends
      | ((ctx: TContext & { stop(): Stop }) => void | Stop | boolean | Promise<void | Stop | boolean>)
      | GuardDef<Record<string, ServiceToken>>
      | readonly GuardDef<Record<string, ServiceToken>>[],
  >(
    check: TG,
  ): SSERouteBuilder<
    TContext,
    TReturns,
    TRequirements | ExtractStepDeps<TG>,
    TPath
  >

  returns<TStatus extends number, TSchema extends import('zod').ZodType>(
    status: TStatus,
    schema: TSchema,
  ): SSERouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, import('zod').infer<TSchema>>,
    TRequirements,
    TPath
  >

  returns<TStatus extends number>(
    status: TStatus,
  ): SSERouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, void>,
    TRequirements,
    TPath
  >

  types<TTypes extends Record<string, abstract new (...args: any[]) => any>>(
    types: TTypes,
  ): SSERouteBuilder<
    Omit<TContext, 'params'> & { params: TypedParams<TPath, TTypes> },
    TReturns,
    TRequirements,
    TPath
  >

  query<TSchema extends import('zod').ZodType>(
    schema: TSchema,
  ): SSERouteBuilder<
    TContext & { query: import('zod').infer<TSchema> },
    TReturns,
    TRequirements,
    TPath
  >

  handle(
    generator: (ctx: TContext) => SSEHandlerReturn,
  ): SSERouteDef<TPath>
}

function createSSERouteBuilder<TPath extends string>(
  path: TPath,
): SSERouteBuilder<SSEContext<Record<string, unknown>, ExtractParams<TPath>>, never, never, TPath> {
  const state = createBuilderState();
  const base = createBaseBuilder<TPath, SSEHandlerReturn>(state, path);

  const builder: SSERouteBuilder<any, any, any, any> = {
    use(middleware) {
      base.use(middleware);
      return builder;
    },
    guard(check) {
      base.guard(check);
      return builder;
    },
    apply(plugin) {
      return plugin(builder as any) as any;
    },
    returns(status: number, schema?: any, permission?: any) {
      base.returns(status, schema, permission);
      return builder;
    },
    types(types) {
      base.types(types);
      return builder;
    },
    query(schema: any) {
      return this.apply(queryPlugin(schema)) as any;
    },
    handle(generator) {
      const routeDef = base.handle(generator as any);
      return {
        ...routeDef,
        method: 'SSE' as const,
      } as unknown as SSERouteDef;
    },
  };

  return builder as any;
}

/** SSE route factory */
export const SSE = <TPath extends string>(path: TPath) =>
  createSSERouteBuilder(path);
