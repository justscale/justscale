/**
 * WebSocket Route Factory
 *
 * Creates WebSocket routes using the builder pattern.
 */

import type { ExtractParams } from '@justscale/core/plugin';
import { type WsRouteBuilder, createWsRouteBuilder } from './builder.js';
import type { WsRouteContext } from './types.js';

/**
 * WebSocket route factory.
 * Only supports builder pattern (no direct handler form).
 *
 * @example
 * ```typescript
 * Ws('/room/:roomId')
 *   .use(authMiddleware)
 *   .message(ChatMessageSchema)
 *   .handle(async ({ messages, send, params, user }) => {
 *     for await (const msg of messages) {
 *       send({ echo: msg.content });
 *     }
 *   })
 * ```
 */
export function Ws<TDeps, TPath extends string>(
  path: TPath,
): WsRouteBuilder<
  TDeps,
  ExtractParams<TPath>,
  WsRouteContext<TDeps, ExtractParams<TPath>>,
  TPath,
  unknown
> {
  return createWsRouteBuilder<TDeps, TPath>(path);
}
