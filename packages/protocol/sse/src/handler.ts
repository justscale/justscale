/**
 * SSE HTTP Handler
 *
 * Handles SSE routes — sets headers, runs the async generator,
 * formats events, manages heartbeat and disconnect cleanup.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { formatSSEEvent, formatHeartbeat } from './format.js';
import { applyTypesConfig } from '@justscale/core/models';
import { executeSteps } from '@justscale/core';
import type { SSEEvent } from './types.js';

const HEARTBEAT_INTERVAL = 15_000;

interface MatchedRoute {
  route: any
  params: Record<string, string>
  deps: Record<string, unknown>
}

/**
 * Handle an SSE request — called by the registered request handler.
 */
export async function handleSSE(
  req: IncomingMessage,
  res: ServerResponse,
  matched: MatchedRoute,
): Promise<void> {
  const route = matched.route;

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Abort signal for disconnect detection
  let resolveAbort: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });

  res.on('close', () => resolveAbort());

  // Heartbeat timer
  const heartbeat = setInterval(() => {
    if (!res.destroyed) {
      res.write(formatHeartbeat());
    }
  }, HEARTBEAT_INTERVAL);

  // Build context for the handler
  const params = route.types
    ? applyTypesConfig(matched.params, route.types)
    : matched.params;

  // Parse query params from URL
  const rawQuery: Record<string, string> = {};
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  url.searchParams.forEach((value, key) => { rawQuery[key] = value; });

  const ctx = {
    params,
    deps: matched.deps,
    rawQuery,
    lastEventId: req.headers['last-event-id'] as string | undefined,
    aborted,
    ...matched.deps,
  };

  try {
    const handler = route.handler;
    if (typeof handler !== 'function') return;

    // Run middleware and guards declared via .use()/.guard() on this SSE route.
    // Steps live in route.steps — route.middlewares/guards are always [].
    const passed = await executeSteps(route, ctx);
    if (!passed) {
      // A guard denied the request. SSE headers were already written (200 OK)
      // before we could check — send an error event and close gracefully.
      if (!res.destroyed) {
        res.write(formatSSEEvent({ event: 'error', data: { message: 'Forbidden' } }));
      }
      return;
    }

    const generator = handler(ctx) as AsyncGenerator<SSEEvent>;

    // Force-return the generator when client disconnects
    // This is needed because the generator may be suspended inside
    // an inner for-await (e.g., waiting on a Queue) that won't
    // respond to the outer for-await breaking.
    const onClose = () => { generator.return(undefined as any); };
    res.on('close', onClose);

    try {
      for await (const event of generator) {
        if (res.destroyed) break;
        res.write(formatSSEEvent(event));
      }
    } finally {
      res.removeListener('close', onClose);
    }
  } catch (err) {
    if (!res.destroyed) {
      res.write(formatSSEEvent({
        event: 'error',
        data: { message: (err as Error).message },
      }));
    }
  } finally {
    clearInterval(heartbeat);
    if (!res.destroyed) {
      res.end();
    }
  }
}
