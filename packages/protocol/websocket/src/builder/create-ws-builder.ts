/**
 * WebSocket Route Builder Factory
 *
 * Creates WebSocket route builders that extend the core builder with WS-specific methods.
 */

import {
  type ContextualControllerInstance,
  createBaseBuilder,
  createBuilderState,
} from '@justscale/core';
import type { z } from 'zod';
import type { WsBaseContext, WsRouteBuilder, WsRouteDef } from './types.js';

/** Symbol to mark message schema on route */
export const MESSAGE_SCHEMA = Symbol.for('justscale:ws:messageSchema');

/** Read the message schema from a route definition. */
export function getMessageSchema(route: unknown): z.ZodType | undefined {
  return (route as Record<symbol, unknown>)?.[MESSAGE_SCHEMA] as z.ZodType | undefined;
}

/** Symbol to mark procedures on route */
export const PROCEDURES_CONTROLLER = Symbol.for(
  'justscale:ws:proceduresController',
);

/**
 * Create a WebSocket route builder.
 * Extends the core builder with WebSocket-specific methods.
 */
export function createWsRouteBuilder<TPath extends string>(
  path: TPath,
): WsRouteBuilder<WsBaseContext<TPath>, never, {}, TPath, unknown> {
  const state = createBuilderState();
  const base = createBaseBuilder(state, path);
  let messageSchema: z.ZodType | undefined;
  let proceduresController: ContextualControllerInstance<any> | undefined;

  const builder: WsRouteBuilder<any, any, any, any, any> = {
    // Delegate core methods to base builder
    use(middleware) {
      base.use(middleware);
      return builder;
    },

    guard(check) {
      base.guard(check);
      return builder;
    },

    apply(plugin) {
      // Plugin transforms builder
      return plugin(builder as any) as any;
    },

    returns(status: number, schema?: z.ZodType, permission?: any) {
      base.returns(status, schema as any, permission);
      return builder;
    },

    types(types) {
      base.types(types);
      return builder;
    },

    // WebSocket-specific: message schema
    message(schema: z.ZodType) {
      messageSchema = schema;
      return builder;
    },

    // WebSocket-specific: link contextual controller
    withProcedures(controller: ContextualControllerInstance<any>) {
      proceduresController = controller;
      base.use((ctx: any) => ({
        createSession: (context: any) => {
          const ws = {
            rawMessages: async function* () {
              for await (const msg of ctx.messages) {
                yield typeof msg === 'string' ? msg : JSON.stringify(msg);
              }
            },
            send: (data: string | Buffer) => {
              const str = typeof data === 'string' ? data : data.toString();
              ctx.send(JSON.parse(str));
            },
          };
          return controller.createSession({ ...context, ws });
        },
      }));
      return builder;
    },

    handle(handler) {
      const routeDef = base.handle(handler);
      const wsRouteDef = {
        ...routeDef,
        method: 'WS' as const,
      } as WsRouteDef<TPath, any, any, any>;

      // Attach message schema for validation
      if (messageSchema) {
        ;(wsRouteDef as any)[MESSAGE_SCHEMA] = messageSchema;
      }

      // Attach procedures controller reference
      if (proceduresController) {
        ;(wsRouteDef as any)[PROCEDURES_CONTROLLER] = proceduresController;
      }

      return wsRouteDef;
    },
  };

  return builder as any;
}

export const Ws = <TPath extends string>(path: TPath) =>
  createWsRouteBuilder(path);
