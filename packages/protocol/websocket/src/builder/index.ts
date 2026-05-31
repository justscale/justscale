/**
 * WebSocket Builder Module
 *
 * Exports for the unified WebSocket route builder.
 */

export type {
  WsContext,
  WsBaseContext,
  WsRouteBuilder,
  WsRouteDef,
} from './types.js';

export {
  createWsRouteBuilder,
  Ws,
  MESSAGE_SCHEMA,
  getMessageSchema,
  PROCEDURES_CONTROLLER,
} from './create-ws-builder.js';
