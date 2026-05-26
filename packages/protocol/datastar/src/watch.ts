/**
 * Watch Route Factory
 *
 * Provides Watch route factory for long-lived SSE subscriptions.
 * Uses async generators for clean lifecycle management.
 *
 * Two call shapes are accepted:
 *   Watch(path, generator)                      // direct form
 *   Watch(path).heartbeat(ms).handle(generator) // chain form, route-local config
 *
 * @example
 * ```typescript
 * routes: ({ Watch }) => ({
 *   userUpdates: Watch("/users/:id").heartbeat(10_000).handle(
 *     async function* ({ params, userStore }) {
 *       while (true) {
 *         const user = await userStore.waitForChange(params.id);
 *         yield { user };
 *       }
 *     },
 *   ),
 * })
 * ```
 */

import type { ExtractParams } from '@justscale/core/plugin';
// Import http types to get SupportedMethods augmentation (GET, POST, etc.)
import type {} from '@justscale/http';
import type { DatastarStream, WatchContext, WatchGenerator } from './types.js';

/** Symbol marker on a route def — set to true for Watch routes. */
export const WATCH_ROUTE = Symbol('@justscale/datastar/watch');

/** Default heartbeat cadence for Watch routes, in milliseconds. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;

/** Key on a Watch route def that carries the heartbeat interval (ms). */
export const WATCH_HEARTBEAT_MS = Symbol('@justscale/datastar/watch-heartbeat-ms');

/** Datastar-specific context (added by datastar server) */
interface DatastarRouteContext<TDeps, TParams> {
  deps: TDeps
  params: TParams
  signals: Record<string, unknown>
  stream: DatastarStream
  /**
   * Resolves when the client disconnects. Supplied by the transport
   * (handleWatch); absent when the handler is invoked directly (tests).
   */
  aborted?: Promise<void>
}

/**
 * Chain builder returned by Watch(path). Allows route-local tuning before
 * the generator is bound via .handle().
 */
export interface WatchBuilder<TDeps, TPath extends string> {
  /**
   * Configure SSE heartbeat cadence for this route.
   * Pass `0` or `false` to disable heartbeats entirely.
   * Defaults to DEFAULT_HEARTBEAT_INTERVAL_MS (15s) when not called.
   */
  heartbeat(ms: number | false): WatchBuilder<TDeps, TPath>
  /** Bind the async generator that produces signals for this route. */
  handle(generator: WatchGenerator<TDeps, ExtractParams<TPath>>): any
}

/** Build the concrete route def from a path, heartbeat cadence, and generator. */
function buildRoute<TDeps, TPath extends string>(
  path: TPath,
  heartbeatMs: number,
  generator: WatchGenerator<TDeps, ExtractParams<TPath>>,
): any {
  return {
    method: 'GET',
    path,
    steps: [],
    responseSchemas: new Map(),
    // Marker consumed by the datastar HTTP request handler to distinguish
    // a Watch route from a plain GET. Route-level content negotiation
    // happens at this level, not via the HTTP method.
    [WATCH_ROUTE]: true,
    [WATCH_HEARTBEAT_MS]: heartbeatMs,
    handler: async (ctx: DatastarRouteContext<TDeps, ExtractParams<TPath>>) => {
      // Prefer the transport's disconnect signal (handleWatch resolves it on
      // client close). When invoked directly (tests) there is none, so fall
      // back to a local promise we resolve on teardown — this keeps
      // `ctx.aborted` a real Promise in every code path.
      let resolveLocalAbort: () => void = () => {};
      const aborted: Promise<void> =
        ctx.aborted instanceof Promise
          ? ctx.aborted
          : new Promise<void>((resolve) => { resolveLocalAbort = resolve; });

      const watchCtx = {
        deps: ctx.deps,
        signals: ctx.signals,
        stream: ctx.stream,
        params: ctx.params,
        aborted,
      } as WatchContext<TDeps, ExtractParams<TPath>>;

      const gen = generator(watchCtx);

      // On disconnect, ask the generator to wind down so its `finally` (resource
      // release) runs. A generator that also observes `ctx.aborted` to close its
      // upstream source unblocks immediately; one parked on an upstream await
      // gets return() queued behind that await (best effort) — hence the
      // documented contract: observe `aborted` to release your own resources.
      void aborted.then(() => { void gen.return(undefined); });

      try {
        for await (const signals of gen) {
          ctx.stream.mergeSignals(signals);
        }
      } catch (err) {
        // Generator threw or was aborted
        if (err instanceof Error && err.message !== 'aborted') {
          console.error('Watch generator error:', err);
        }
      } finally {
        resolveLocalAbort();
      }
    },
  };
}

/**
 * Create a Watch route that uses an async generator for streaming.
 * Each yield sends signals to the client.
 *
 * Direct form: `Watch(path, generator)` — uses the default heartbeat cadence.
 * Chain form:  `Watch(path).heartbeat(ms).handle(generator)` — route-local
 *              control over the heartbeat cadence (pass `0` / `false` to
 *              disable).
 */
export function Watch<TDeps, TPath extends string>(
  path: TPath,
  generator: WatchGenerator<TDeps, ExtractParams<TPath>>,
): any;
export function Watch<TDeps, TPath extends string>(
  path: TPath,
): WatchBuilder<TDeps, TPath>;
export function Watch<TDeps, TPath extends string>(
  path: TPath,
  generator?: WatchGenerator<TDeps, ExtractParams<TPath>>,
): any {
  if (typeof generator === 'function') {
    return buildRoute<TDeps, TPath>(path, DEFAULT_HEARTBEAT_INTERVAL_MS, generator);
  }

  let heartbeatMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
  const builder: WatchBuilder<TDeps, TPath> = {
    heartbeat(ms: number | false) {
      // `false` or `0` -> disabled. Negative values are coerced to disabled too.
      heartbeatMs = ms === false || !(Number(ms) > 0) ? 0 : Number(ms);
      return builder;
    },
    handle(gen) {
      return buildRoute<TDeps, TPath>(path, heartbeatMs, gen);
    },
  };
  return builder;
}
