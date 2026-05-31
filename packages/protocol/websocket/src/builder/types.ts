/**
 * WebSocket Route Builder Types
 *
 * Extends core RouteBuilder with WebSocket-specific methods.
 */

import type {
  BuilderPlugin,
  ContextualControllerInstance,
  ExtractAddedFromMiddleware,
  ExtractStepDeps,
  GuardDef,
  MiddlewareDef,
  ResponseEntry,
  RouteBuilderV2 as RouteBuilder,
  RouteDefV2 as RouteDef,
  ServiceToken,
  Session,
  Stop,
} from '@justscale/core';
import type { TypedParams } from '@justscale/core/models';
import type { z } from 'zod';

/**
 * WebSocket connection context - provided by the server on upgrade.
 */
export interface WsContext<TMessage = unknown> {
  /** Async iterable of validated messages */
  messages: AsyncIterable<TMessage>
  /** Send a message to the client */
  send: (data: unknown) => void
  /** Close the connection gracefully */
  close: (code?: number, reason?: string) => void
  /** Promise that resolves when connection closes */
  closed: Promise<void>
}

/**
 * WebSocket-specific base context provided by the protocol.
 * This is what the server injects before route execution.
 */
export interface WsBaseContext<TPath extends string>
  extends WsContext<unknown> {
  params: ExtractParams<TPath>
  query: Record<string, string>
}

/**
 * Extract params from path like '/room/:id' -> { id: string }
 */
type ExtractParams<T extends string> =
  T extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string } & ExtractParams<`/${Rest}`>
    : T extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : {};

/**
 * WebSocket Route Builder - extends core RouteBuilder with WebSocket-specific methods.
 *
 * @typeParam TContext - Accumulated context from middleware
 * @typeParam TReturns - Union of possible responses (ResponseEntry union)
 * @typeParam TRequirements - Accumulated DI requirements from plugins
 * @typeParam TPath - Route path literal for param extraction
 * @typeParam TMessage - Message type from schema
 */
export interface WsRouteBuilder<
  TContext,
  TReturns,
  TRequirements,
  TPath extends string,
  TMessage = unknown,
> extends RouteBuilder<TContext, TReturns, TRequirements, TPath> {
  /**
   * Add middleware that extends context.
   * Runs ONCE on upgrade, before the handler starts.
   * DI-aware MiddlewareDef contributes its inject deps to TRequirements.
   */
  use<
    TMw extends
      | ((ctx: TContext) => object | Promise<object>)
      | MiddlewareDef<object, any>,
  >(
    middleware: TMw,
  ): WsRouteBuilder<
    TContext & ExtractAddedFromMiddleware<TMw>,
    TReturns,
    TRequirements | ExtractStepDeps<TMw>,
    TPath,
    TMessage
  >

  /**
   * Add guard that can stop execution.
   * Runs ONCE on upgrade - if rejected, connection is closed immediately.
   * DI-aware GuardDef contributes its inject deps to TRequirements.
   */
  guard<
    TG extends
      | ((ctx: TContext & { stop(): Stop }) => void | Stop | boolean | Promise<void | Stop | boolean>)
      | GuardDef<Record<string, ServiceToken>>
      | readonly GuardDef<Record<string, ServiceToken>>[],
  >(
    check: TG,
  ): WsRouteBuilder<
    TContext,
    TReturns,
    TRequirements | ExtractStepDeps<TG>,
    TPath,
    TMessage
  >

  /**
   * Apply a plugin that can chain multiple operations.
   */
  apply<TCtxOut, TRetOut, TReqOut>(
    plugin: BuilderPlugin<
      TContext,
      TCtxOut,
      TReturns,
      TRetOut,
      TRequirements,
      TReqOut,
      TPath
    >,
  ): WsRouteBuilder<TCtxOut, TRetOut, TReqOut, TPath, TMessage>

  /**
   * Declare a possible response with schema.
   */
  returns<TStatus extends number, TSchema extends z.ZodType>(
    status: TStatus,
    schema: TSchema,
  ): WsRouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, z.infer<TSchema>>,
    TRequirements,
    TPath,
    TMessage
  >

  /**
   * Declare a possible response without body.
   */
  returns<TStatus extends number>(
    status: TStatus,
  ): WsRouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, void>,
    TRequirements,
    TPath,
    TMessage
  >

  /**
   * Declare model types for path params.
   * Transforms matching params from `string` to `Reference<T>`.
   */
  types<TTypes extends Record<string, abstract new (...args: any[]) => any>>(
    types: TTypes,
  ): WsRouteBuilder<
    Omit<TContext, 'params'> & { params: TypedParams<TPath, TTypes> },
    TReturns,
    TRequirements,
    TPath,
    TMessage
  >

  // WebSocket-specific methods

  /**
   * Specify the message schema for incoming messages.
   * All messages are validated against this schema.
   * Invalid messages are silently dropped.
   *
   * @example
   * ```typescript
   * Ws('/chat/:roomId')
   *   .message(z.object({ type: z.string(), content: z.string() }))
   *   .handle(async ({ messages }) => {
   *     for await (const msg of messages) {
   *       // msg is typed as { type: string, content: string }
   *     }
   *   })
   * ```
   */
  message<TSchema extends z.ZodType>(
    schema: TSchema,
  ): WsRouteBuilder<
    Omit<TContext, 'messages'> & { messages: AsyncIterable<z.infer<TSchema>> },
    TReturns,
    TRequirements,
    TPath,
    z.infer<TSchema>
  >

  /**
   * Link a contextual controller to this WebSocket route.
   * Adds a typed `createSession` function to the handler context.
   *
   * @example
   * ```typescript
   * Ws('/')
   *   .withProcedures(procedures)
   *   .handle(async ({ createSession, query }) => {
   *     using session = createSession({ username: query.username })
   *     await session.run()
   *   })
   * ```
   */
  withProcedures<
    TSessionContext extends {
      ws: {
        rawMessages(): AsyncIterable<string | Buffer>
        send(data: string | Buffer): void
      }
    },
  >(
    controller: ContextualControllerInstance<TSessionContext>,
  ): WsRouteBuilder<
    TContext & {
      createSession: (
        context: Omit<TSessionContext, 'ws'>,
      ) => Session<TSessionContext>
    },
    TReturns,
    TRequirements,
    TPath,
    TMessage
  >

  /**
   * Set final handler.
   * The handler receives an async iterable of messages.
   * When the handler returns (or throws), the connection is closed.
   */
  handle(
    handler: (ctx: TContext) => void | Promise<void>,
  ): WsRouteDef<TPath, TReturns, TRequirements, TMessage>
}

/**
 * WebSocket-specific route definition.
 * Extends core RouteDef with WS method.
 */
export interface WsRouteDef<
  TPath extends string,
  TReturns,
  TRequirements,
  _TMessage = unknown,
> extends RouteDef<TPath, TReturns, TRequirements> {
  method: 'WS'
}
