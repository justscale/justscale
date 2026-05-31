/**
 * WebSocket Route Builder Implementation
 *
 * Provides the builder pattern for WebSocket routes with middleware, guards,
 * and message schema validation.
 */

import type {
  Guard,
  Middleware,
} from '@justscale/core/middleware';
import type { Prettify } from '@justscale/core/plugin';
import type { TypesConfig, TypedParams } from '@justscale/core/models';
import type { z } from 'zod';
import type { WsContext } from './types.js';

/** Symbol to mark message schema on route */
export const MESSAGE_SCHEMA = Symbol.for('justscale:ws:messageSchema');

interface Step {
  type: 'use' | 'guard'
  fn: any
}

/**
 * WebSocket route builder - fluent API for defining WS routes.
 *
 * @example
 * ```typescript
 * Ws('/chat/:roomId')
 *   .use(authMiddleware)
 *   .guard(roomAccess)
 *   .message(ChatMessage)
 *   .handle(async ({ messages, send, params }) => {
 *     for await (const msg of messages) {
 *       send({ text: msg.text, room: params.roomId });
 *     }
 *   })
 * ```
 */
export interface WsRouteBuilder<
  TDeps,
  TParams,
  TContext extends WsContext<any> & { params: TParams },
  TPath extends string,
  TMessage = unknown,
> {
  /**
   * Add middleware that transforms the request context.
   */
  use<TAdded>(
    middleware: Middleware<TContext, TAdded> | (new (...args: any[]) => any),
  ): WsRouteBuilder<
    TDeps,
    TParams,
    Prettify<TContext & TAdded>,
    TPath,
    TMessage
  >

  /**
   * Add a guard that can reject the WebSocket connection.
   */
  guard(
    check: Guard<TContext> | (new (...args: any[]) => any),
  ): WsRouteBuilder<TDeps, TParams, TContext, TPath, TMessage>

  /**
   * Configure typed path params. Each entry maps a path-param name to a
   * model class; at handler time, those params become `Reference<T>`
   * objects with resolvers attached, so `await params.room` works.
   *
   * Mirrors the HTTP/SSE `.types()` contract. Without this, `params.room`
   * stays a bare string and code that builds refs from it must attach
   * resolvers manually.
   */
  types<TTypes extends TypesConfig>(
    types: TTypes,
  ): WsRouteBuilder<
    TDeps,
    TypedParams<TPath, TTypes>,
    Omit<TContext, 'params'> & { params: TypedParams<TPath, TTypes> },
    TPath,
    TMessage
  >

  /**
   * Set the expected message schema for incoming WebSocket messages.
   * All messages are validated against this schema.
   * Invalid messages are silently dropped.
   */
  message<TSchema extends z.ZodType>(
    schema: TSchema,
  ): WsRouteBuilder<
    TDeps,
    TParams,
    Omit<TContext, 'messages'> & { messages: AsyncIterable<z.infer<TSchema>> },
    TPath,
    z.infer<TSchema>
  >

  /**
   * Set the handler for the WebSocket connection.
   * The handler receives an async iterable of messages.
   * When the handler returns (or throws), the connection is closed.
   */
  handle(
    handler: (ctx: TContext) => void | Promise<void>,
  ): any
}

/** Create a WsRouteBuilder for the given path */
export function createWsRouteBuilder<TDeps, TPath extends string>(
  path: TPath,
): WsRouteBuilder<TDeps, any, any, TPath, unknown> {
  const steps: Step[] = [];
  let messageSchema: z.ZodType | undefined;
  let typesConfig: TypesConfig | undefined;

  const builder: any = {
    use(middleware: any) {
      steps.push({ type: 'use', fn: middleware });
      return builder;
    },

    guard(check: any) {
      steps.push({ type: 'guard', fn: check });
      return builder;
    },

    types(types: TypesConfig) {
      typesConfig = types;
      return builder;
    },

    message(schema: z.ZodType) {
      messageSchema = schema;
      return builder;
    },

    handle(handler: any) {
      const route: any = {
        method: 'WS',
        path,
        steps: [...steps],
        responseSchemas: new Map(),
        handler,
      };

      if (typesConfig) route.types = typesConfig;
      if (messageSchema) route[MESSAGE_SCHEMA] = messageSchema;

      return route;
    },
  };

  return builder;
}

/**
 * WebSocket route factory.
 *
 * @example
 * ```typescript
 * Ws('/chat/:roomId')
 *   .message(ChatMessage)
 *   .handle(async ({ messages, send }) => {
 *     for await (const msg of messages) {
 *       send({ echo: msg.text });
 *     }
 *   })
 * ```
 */
export function Ws<TPath extends string>(path: TPath) {
  return createWsRouteBuilder<Record<string, unknown>, TPath>(path);
}

/** Get the message schema from a route definition (if set via .message()) */
export function getMessageSchema(route: unknown): import('zod').ZodType | undefined {
  return (route as Record<symbol, unknown>)?.[MESSAGE_SCHEMA] as import('zod').ZodType | undefined;
}
