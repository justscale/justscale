import type { ExtractParams, Prettify } from '@justscale/core/plugin';
import type { WsRouteBuilder } from './builder.js';

/**
 * WebSocket connection context - fully abstract, no raw WebSocket.
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
  /** Query parameters from the WebSocket connection URL */
  query: Record<string, string>
}

/**
 * Full WebSocket handler context - transport context only.
 * Dependencies are accessed via closure capture from the routes function (service.xxx).
 */
export type WsRouteContext<
  _TDeps = Record<string, unknown>,
  TParams = Record<string, string>,
  TMessage = unknown,
> = Prettify<WsContext<TMessage> & { params: TParams }>;

/**
 * WebSocket route handler type.
 */
export type WsRouteHandler<
  TDeps = Record<string, unknown>,
  TParams = Record<string, string>,
  TMessage = unknown,
> = (ctx: WsRouteContext<TDeps, TParams, TMessage>) => void | Promise<void>;

/**
 * WebSocket factory type - supports builder pattern only.
 */
export type WsFactory<TDeps> = <TPath extends string>(
  path: TPath,
) => WsRouteBuilder<
  TDeps,
  ExtractParams<TPath>,
  WsRouteContext<TDeps, ExtractParams<TPath>>,
  TPath
>;

// ============================================================================
// Module Augmentation - WebSocket Transport
// ============================================================================

declare module '@justscale/core' {
  /**
   * WebSocket method - extends SupportedMethods.
   */
  interface SupportedMethods {
    WS: { transport: 'websocket'; hasBody: false; idempotent: false }
  }
}

declare module '@justscale/core/plugin' {
  interface RouteFactories<TDeps> {
    Ws: WsFactory<TDeps>
  }
}
