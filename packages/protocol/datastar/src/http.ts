/**
 * Datastar HTTP Handler
 *
 * Intercepts matched Watch routes (flagged via the WATCH_ROUTE symbol),
 * sets SSE headers, builds a ConcreteDatastarStream on top of the node
 * ServerResponse, then invokes the route's handler with it.
 *
 * Mirrors how @justscale/sse wires itself into the HTTP server.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { applyTypesConfig } from '@justscale/core/models';
import { createDatastarStream } from './stream.js';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  WATCH_HEARTBEAT_MS,
  WATCH_ROUTE,
} from './watch.js';

interface MatchedRoute {
  route: any
  params: Record<string, string>
  deps: Record<string, unknown>
}

/**
 * Parse the `?datastar=<json>` query param produced by the Datastar client.
 * The param carries the client's current signal store so the server can
 * hydrate handlers with it. Returns {} for any shape that isn't a plain
 * object — no throwing.
 */
function parseSignalsFromQuery(
  searchParams: URLSearchParams,
): Record<string, unknown> {
  const raw = searchParams.get('datastar');
  if (raw === null || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/**
 * Handle a matched Watch request. Runs the handler with a concrete datastar
 * stream wired to the response, and ensures the response is closed on exit.
 */
export async function handleWatch(
  req: IncomingMessage,
  res: ServerResponse,
  matched: MatchedRoute,
): Promise<void> {
  const route = matched.route;

  // Coerce params according to the route's .types() config if present.
  const params = route.types
    ? applyTypesConfig(matched.params, route.types)
    : matched.params;

  const stream = createDatastarStream(res);

  // Resolves when the client disconnects (wired to req/res close below). The
  // Watch handler exposes this as `ctx.aborted` so long-lived generators can
  // release their resources instead of leaking until their source closes.
  let resolveAborted: () => void = () => {};
  const aborted = new Promise<void>((resolve) => { resolveAborted = resolve; });

  // Parse query params from URL so Watch handlers can read them.
  const rawQuery: Record<string, string> = {};
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  url.searchParams.forEach((value, key) => { rawQuery[key] = value; });

  // Hydrate ctx.signals from the `?datastar=` JSON blob the Datastar client
  // sends on GET. Absent / malformed input -> empty object, never throws.
  const signals = parseSignalsFromQuery(url.searchParams);

  // Reserved fields are assigned AFTER the deps spread so an injected service
  // named `stream`/`signals`/`params`/`aborted`/`deps`/`rawQuery` cannot clobber
  // the context the Watch handler depends on. Such a dep is still reachable via
  // `ctx.deps`.
  const ctx = {
    ...matched.deps,
    params,
    deps: matched.deps,
    signals,
    stream,
    rawQuery,
    aborted,
  };

  // Schedule periodic SSE heartbeats so intermediaries (nginx, ELB, etc.)
  // don't kill the idle connection. The interval is cleared on any of:
  // request abort, response close, write failure, handler termination.
  const heartbeatMs = resolveHeartbeatMs(route);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatStopped = false;

  const stopHeartbeat = (): void => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (res.destroyed || !res.writable) {
        stopHeartbeat();
        return;
      }
      try {
        stream.heartbeat();
      } catch {
        // Write failed — socket is gone. Stop trying.
        stopHeartbeat();
      }
    }, heartbeatMs);
    // Don't let the heartbeat timer keep the process alive on its own.
    if (typeof (heartbeatTimer as { unref?: () => void }).unref === 'function') {
      (heartbeatTimer as { unref: () => void }).unref();
    }
  }

  // Wire lifecycle listeners so a torn-down connection both resolves the
  // abort signal (so the Watch generator can wind down and run its cleanup)
  // and stops the heartbeat timer.
  const onAbort = (): void => { resolveAborted(); stopHeartbeat(); };
  req.on('close', onAbort);
  req.on('aborted', onAbort);
  res.on('close', onAbort);

  try {
    const handler = route.handler;
    if (typeof handler !== 'function') return;
    await handler(ctx);
  } catch (err) {
    if (!res.destroyed) {
      // Best-effort error signalling as a datastar merge-signals.
      try {
        stream.mergeSignals({ error: (err as Error).message });
      } catch {
        // Writable may be in a torn-down state — ignore.
      }
    }
  } finally {
    // Resolve on normal completion too, so the promise never dangles and any
    // `ctx.aborted` listener settles (it's a no-op on an already-done generator).
    resolveAborted();
    stopHeartbeat();
    req.off('close', onAbort);
    req.off('aborted', onAbort);
    res.off('close', onAbort);
    if (!res.destroyed) res.end();
  }
}

/**
 * Pull the heartbeat cadence (ms) off a Watch route def. Falls back to the
 * default when the route was built without a heartbeat setting (e.g. the
 * direct `Watch(path, generator)` form before this symbol was added).
 * `0` / negative values mean "disabled".
 */
function resolveHeartbeatMs(route: unknown): number {
  if (!route || typeof route !== 'object') return DEFAULT_HEARTBEAT_INTERVAL_MS;
  const raw = (route as Record<symbol, unknown>)[WATCH_HEARTBEAT_MS];
  if (raw === undefined) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/** Returns true if a matched route is a datastar Watch route. */
export function isWatchRoute(route: unknown): boolean {
  return !!route && typeof route === 'object' && (route as Record<symbol, unknown>)[WATCH_ROUTE] === true;
}
