/**
 * @justscale/websocket
 *
 * WebSocket Route Factory Plugin
 *
 * Provides Ws route factory for WebSocket endpoints with async iterable message handling.
 *
 * @example
 * ```typescript
 * import "@justscale/websocket";
 *
 * const ChatController = createController("/chat", {
 *   inject: { rooms: RoomService },
 *   routes: ({ Ws }) => ({
 *     room: Ws("/room/:roomId")
 *       .use(authMiddleware)
 *       .message(ChatMessageSchema)
 *       .handle(async ({ messages, send, params, user }) => {
 *         for await (const msg of messages) {
 *           send({ echo: msg.content });
 *         }
 *         // Connection closed - cleanup happens naturally
 *       }),
 *   }),
 * });
 * ```
 */

import { registerRouteFactory } from '@justscale/core/plugin';
import { Ws } from './factory.js';

export { Ws } from './factory.js';
export { createWsRouteBuilder, MESSAGE_SCHEMA, getMessageSchema } from './builder.js';
export type { WsRouteBuilder } from './builder.js';
export { createWsHandler } from './server.js';
export type { WsHandler } from './server.js';
export type {
  WsContext,
  WsRouteContext,
  WsRouteHandler,
  WsFactory,
} from './types.js';

// type augmentation side-effect
import './types.js';
import './cluster.js';

registerRouteFactory('Ws', Ws);
