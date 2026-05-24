/**
 * @justscale/sse — Server-Sent Events protocol for JustScale
 *
 * Provides an SSE() route factory for streaming events to HTTP clients.
 * Integrates with the HTTP server via registerRequestHandler.
 *
 * @example
 * ```typescript
 * import { SSE } from '@justscale/sse'
 *
 * createController({
 *   inject: { bus: EventBus },
 *   routes: ({ bus }) => ({
 *     events: SSE('/events')
 *       .handle(async function* (ctx) {
 *         for await (const e of bus.subscribe('*')) {
 *           yield { event: e.type, data: e.payload }
 *         }
 *       }),
 *   }),
 * })
 * ```
 */

export { SSE } from './factory.js';
export type { SSERouteDef } from './factory.js';
export type { SSEEvent, SSEContext, SSEGenerator } from './types.js';
export { formatSSEEvent, formatHeartbeat } from './format.js';
export { handleSSE } from './handler.js';

// Register SSE request handler with HTTP server
import { registerRequestHandler } from '@justscale/http';
import { handleSSE } from './handler.js';

registerRequestHandler(async (req, res, matched) => {
  if ((matched.route as any).method !== 'SSE') return false;
  await handleSSE(req, res, matched as any);
  return true;
});
