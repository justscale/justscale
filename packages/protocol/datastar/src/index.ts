/**
 * @justscale/datastar
 *
 * Datastar Plugin for SSE streaming and signal management.
 *
 * @example
 * ```typescript
 * import "@justscale/http";
 * import "@justscale/datastar";
 *
 * routes: ({ Get, Watch }) => ({
 *   // Regular HTTP route
 *   list: Get("/items", ({ stream }) => { ... }),
 *
 *   // Long-lived subscription
 *   updates: Watch("/items/updates", async function* ({ items }) {
 *     for await (const item of items.subscribe()) {
 *       yield { item };
 *     }
 *   }),
 * })
 * ```
 */

import { registerRouteFactory } from '@justscale/core/plugin';
import { registerRequestHandler } from '@justscale/http';
import { Watch } from './watch.js';
import { handleWatch, isWatchRoute } from './http.js';

// Re-export everything
export {
  Watch,
  WATCH_ROUTE,
  WATCH_HEARTBEAT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from './watch.js';
export type { WatchBuilder } from './watch.js';
export type {
  DatastarContext,
  DatastarStream,
  WatchContext,
  WatchGenerator,
  WatchFactory,
} from './types.js';

// Repository
export { SignalRepository, createSignalRepository } from './repository.js';

// HTML utilities
export { html, rawHtml } from './html.js';

// SSE wire-format encoders (pure)
export {
  encodeMergeSignals,
  encodeMergeFragments,
  encodeRemoveFragments,
  encodeRemoveSignals,
  encodeExecuteScript,
  encodeHeartbeat,
} from './encoder.js';
export type {
  MergeMode,
  MergeFragmentsOptions,
  ExecuteScriptOptions,
} from './encoder.js';

// Stream wrapper
export {
  createDatastarStream,
  DATASTAR_SSE_HEADERS,
} from './stream.js';
export type {
  ConcreteDatastarStream,
  DatastarWritable,
} from './stream.js';

// HTTP handler (exposed for tests + custom integrations)
export { handleWatch, isWatchRoute } from './http.js';

// Import types for augmentation side effect
import './types.js';

// Register factories
registerRouteFactory('Watch', Watch);

// Intercept matched Watch routes before the core HTTP JSON pipeline runs.
registerRequestHandler(async (req, res, matched) => {
  if (!isWatchRoute(matched.route)) return false;
  await handleWatch(req, res, matched as any);
  return true;
});
