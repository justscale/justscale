/**
 * WebSocket Server Integration
 *
 * Handles WebSocket upgrades and creates async iterable message streams.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { App, MatchedRoute } from '@justscale/core';
import { createStopFn, isStop, runInFullRequestScope } from '@justscale/core';
import { applyTypesConfig } from '@justscale/core/models';
import { WebSocket, WebSocketServer } from 'ws';
import { getMessageSchema } from './builder.js';

export interface WsHandler {
  handleUpgrade: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => Promise<boolean>
  close: () => void
}

/**
 * Minimal `ws.WebSocket` shape that `drainAndClose` uses. Defined as
 * a structural interface so tests can pass a fake without instantiating
 * a real socket.
 */
export interface DrainableSocket {
  readonly bufferedAmount: number
  readonly readyState: number
}

/**
 * Drain the WebSocket send buffer before close. The `ws` lib has no
 * "buffer drained" event, so we poll bufferedAmount, but cap the wait
 * via DRAIN_DEADLINE_MS so a slow / dead client can't keep the handler
 * alive forever. Past the deadline we return; the caller closes anyway
 * and accepts the tail bytes may be lost.
 *
 * Resolves when the buffer empties OR the deadline passes OR the socket
 * leaves the OPEN state.
 *
 * Exported for unit-testing.
 */
export async function drainAndClose(
  ws: DrainableSocket,
  options: { deadlineMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? 5_000;
  const pollMs = options.pollMs ?? 10;
  const stop = Date.now() + deadlineMs;
  // WebSocket.OPEN is 1 in the ws library — match by numeric value so
  // the test can use a fake without depending on the ws lib's enum.
  const OPEN = 1;
  while (
    ws.bufferedAmount > 0 &&
    ws.readyState === OPEN &&
    Date.now() < stop
  ) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Create a WebSocket handler for an App.
 * Returns a function to handle HTTP upgrade requests.
 */
export function createWsHandler(app: App): WsHandler {
  const wss = new WebSocketServer({ noServer: true });

  async function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    const matched = app.match('WS', pathname);
    if (!matched) {
      return false;
    }

    // Run middleware + guards against the HTTP Upgrade request BEFORE completing
    // the WebSocket handshake. This prevents unauthenticated clients from holding
    // open connections and exhausting server resources.
    const preUpgradeResult = await runPreUpgradeSteps(matched, req, url);
    if (!preUpgradeResult.allowed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    return new Promise((resolve) => {
      wss.handleUpgrade(req, socket, head, async (ws) => {
        try {
          await handleConnection(ws, matched, req, url, app, preUpgradeResult.enrichments);
        } catch (err) {
          console.error('WebSocket handler error:', err);
          ws.close(1011, 'Internal error');
        }
        resolve(true);
      });
    });
  }

  /**
   * Run all middleware (.use) and guard steps against the raw HTTP Upgrade
   * request before the WebSocket handshake is completed. Guards that reject
   * cause the socket to be closed with 401 at the TCP level, so no WS
   * connection slot is ever allocated for unauthenticated requests.
   *
   * Returns { allowed: true, enrichments } when all steps pass, or
   * { allowed: false } when any guard rejects.
   */
  async function runPreUpgradeSteps(
    matched: MatchedRoute,
    req: IncomingMessage,
    url: URL,
  ): Promise<{ allowed: true; enrichments: Record<string, unknown> } | { allowed: false }> {
    const { route, deps, params } = matched;

    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const ctx: Record<string, unknown> = {
      ...deps,
      params: route.types
        ? applyTypesConfig(params, route.types)
        : params,
      headers: req.headers as Record<string, string>,
      query,
    };

    const steps = (route as any).steps as Array<{
      type: 'use' | 'guard'
      fn: (ctx: any) => unknown
    }>;

    for (const step of steps) {
      try {
        if (step.type === 'use') {
          const additions = await step.fn(ctx);
          Object.assign(ctx, additions);
        } else {
          const stop = createStopFn();
          (ctx as any).stop = stop;
          const result = await step.fn(ctx);
          (ctx as any).stop = undefined;
          if (isStop(result) || result === false) {
            return { allowed: false };
          }
        }
      } catch (err) {
        // A throwing middleware/guard is treated as denial: close the socket
        // without running the handler. Without this catch, the error would
        // propagate up to the HTTP server's upgrade handler and crash the
        // upgrade silently.
        console.error('WebSocket pre-upgrade step error:', err);
        return { allowed: false };
      }
    }

    // Capture everything the use-steps added (minus the base fields) so that
    // handleConnectionInner can merge them into the full WS context without
    // re-running the steps.
    const baseKeys = new Set(['params', 'headers', 'query', 'stop', ...Object.keys(deps)]);
    const enrichments: Record<string, unknown> = {};
    for (const key of Object.keys(ctx)) {
      if (!baseKeys.has(key)) {
        enrichments[key] = ctx[key];
      }
    }

    return { allowed: true, enrichments };
  }

  async function handleConnection(
    ws: WebSocket,
    matched: MatchedRoute,
    req: IncomingMessage,
    url: URL,
    _app: App,
    preUpgradeEnrichments: Record<string, unknown>,
  ): Promise<void> {
    const { route, deps, params } = matched;
    const messageSchema = getMessageSchema(route);

    return runInFullRequestScope(
      {
        container: app.container,
        type: 'ws',
        name: `WS ${route.path}`,
        metadata: {
          'ws.path': route.path,
          'route.name': route.name,
        },
      },
      async () => {
        await handleConnectionInner(ws, route, deps, params, messageSchema, req, url, preUpgradeEnrichments);
      }
    );
  }

  async function handleConnectionInner(
    ws: WebSocket,
    route: MatchedRoute['route'],
    deps: MatchedRoute['deps'],
    params: MatchedRoute['params'],
    messageSchema: { safeParse(data: unknown): { success: boolean; data?: unknown; error?: unknown } } | undefined,
    req: IncomingMessage,
    url: URL,
    preUpgradeEnrichments: Record<string, unknown>,
  ): Promise<void> {
    const messageQueue: unknown[] = [];
    let messageResolver: ((value: IteratorResult<unknown>) => void) | null = null;
    let connectionClosed = false;
    let closeResolver: (() => void) | null = null;

    const closed = new Promise<void>((resolve) => {
      closeResolver = resolve;
    });

    ws.on('message', (data) => {
      if (connectionClosed) return;

      try {
        const parsed = JSON.parse(data.toString());

        if (messageSchema) {
          const result = messageSchema.safeParse(parsed);
          if (!result.success) return;
          if (messageResolver) {
            messageResolver({ value: result.data, done: false });
            messageResolver = null;
          } else {
            messageQueue.push(result.data);
          }
        } else {
          if (messageResolver) {
            messageResolver({ value: parsed, done: false });
            messageResolver = null;
          } else {
            messageQueue.push(parsed);
          }
        }
      } catch {
        // invalid JSON - drop
      }
    });

    ws.on('close', () => {
      connectionClosed = true;
      if (messageResolver) {
        messageResolver({ value: undefined, done: true });
        messageResolver = null;
      }
      closeResolver?.();
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      connectionClosed = true;
      if (messageResolver) {
        messageResolver({ value: undefined, done: true });
        messageResolver = null;
      }
      closeResolver?.();
    });

    const messages: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            if (messageQueue.length > 0) {
              return { value: messageQueue.shift()!, done: false };
            }
            if (connectionClosed) {
              return { value: undefined, done: true };
            }
            return new Promise((resolve) => {
              messageResolver = resolve;
            });
          },
        };
      },
    };

    const send = (data: unknown) => {
      if (!connectionClosed && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    };

    const close = (code?: number, reason?: string) => {
      if (!connectionClosed) {
        ws.close(code, reason);
      }
    };

    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    // Merge pre-upgrade enrichments (from middleware/use steps that ran before
    // the handshake) so the handler sees the same enriched context (e.g. user
    // object added by auth middleware). Steps are not re-run here — they
    // already executed and guards already passed pre-upgrade.
    const ctx: Record<string, unknown> = {
      ...deps,
      ...preUpgradeEnrichments,
      params: route.types
        ? applyTypesConfig(params, route.types)
        : params,
      headers: req.headers as Record<string, string>,
      query,
      send,
      close,
      closed,
      messages,
    };

    try {
      await route.handler(ctx);
    } finally {
      if (!connectionClosed && ws.readyState === WebSocket.OPEN) {
        await drainAndClose(ws);
        if (!connectionClosed && ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'Handler completed');
        }
      }
    }
  }

  return {
    handleUpgrade,
    close: () => wss.close(),
  };
}
