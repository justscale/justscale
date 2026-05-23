import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { App } from '@justscale/core';
import { executeRoute } from '@justscale/core';
import { ADAPTER_KEY, applyTypesConfig, filterByAccess, ACCESS_RULES } from '@justscale/core/models';
import { getAccessPrincipals } from '@justscale/core';

/** Serialize to JSON; injects non-enumerable `id` from ADAPTER_KEY and filters fields by access rules. */
function serializeJson(data: unknown): string {
  const principals = getAccessPrincipals();
  return JSON.stringify(data, (_key, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const adapterKey = (value as Record<symbol, unknown>)[ADAPTER_KEY];
      if (adapterKey !== undefined) {
        // Persistent entity - check for access rules
        const modelClass = Object.getPrototypeOf(Object.getPrototypeOf(value))?.constructor;
        if (principals && modelClass?.[ACCESS_RULES]) {
          return { id: adapterKey, ...filterByAccess(value as Record<string, unknown>, modelClass, principals) };
        }
        return { id: adapterKey, ...value };
      }
    }
    return value;
  });
}

export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => Promise<boolean>;

const upgradeHandlers: UpgradeHandler[] = [];

export function registerUpgradeHandler(handler: UpgradeHandler): void {
  upgradeHandlers.push(handler);
}

export type RequestHandler = (
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
  matched: { route: unknown; params: Record<string, string>; deps: Record<string, unknown> },
) => Promise<boolean> | boolean;

const requestHandlers: RequestHandler[] = [];

/** Intercepts matched routes before JSON handling (e.g., for SSE). */
export function registerRequestHandler(handler: RequestHandler): void {
  requestHandlers.push(handler);
}

export interface JsonResponse<T = unknown> {
  json(data: T): void
  /** Send a UTF-8 HTML response with `text/html; charset=utf-8`. */
  html(content: string): void
  error(message: string, status?: number): void
  status<S extends number>(code: S): StatusedResponse<S, T>
}

export interface StatusedResponse<_S extends number, _TResponses = unknown> {
  json(data: unknown): void
  /** End the response with no body (for empty responses like 204, 403, 409) */
  end(): void
}

/** Returns raw Buffer for multipart, parsed JSON otherwise. */
async function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let exceeded = false;
    req.on('data', (chunk: Buffer) => {
      if (exceeded) return; // already over — drop further chunks, no buffering
      bytesRead += chunk.byteLength;
      if (bytesRead > maxBodyBytes) {
        exceeded = true;
        // Reject NOW so the caller can write the 413 response. Do NOT
        // call req.destroy() here — that races the response write and
        // the client sees a connection reset instead of the 413.
        // The caller is responsible for ending/destroying after writing.
        reject(Object.assign(new Error('Payload Too Large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) return; // already rejected; ignore end
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] ?? '';
      // Multipart or other binary - expose raw Buffer
      if (contentType.startsWith('multipart/')) {
        resolve(buffer);
        return;
      }
      if (!buffer.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(buffer.toString()));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export interface ListenOptions {
  /**
   * Maximum allowed request body size in bytes.
   * Requests exceeding this limit are rejected with 413 Payload Too Large.
   * @default 1048576 (1 MB)
   */
  maxBodyBytes?: number;
  /**
   * Allowed CORS origins.
   * - `undefined` (default): no CORS headers emitted (default-secure).
   * - `string[]`: reflect the request Origin when it matches one of the listed values.
   * - `'*'`: emit wildcard Access-Control-Allow-Origin.
   *   WARNING: wildcard is incompatible with credentialed requests
   *   (Access-Control-Allow-Credentials: true). Set an explicit list when
   *   using credentials.
   *
   * NOTE: pre-1.0 default was `'*'`. Existing apps that relied on the
   * implicit wildcard must set `allowedOrigins: '*'` explicitly.
   */
  allowedOrigins?: string[] | '*';
}

export function listen(app: App, port: number, options: ListenOptions = {}): Server {
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const allowedOrigins = options.allowedOrigins;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const method = req.method ?? 'GET';

    if (allowedOrigins === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      );
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    } else if (Array.isArray(allowedOrigins)) {
      const origin = req.headers['origin'];
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader(
          'Access-Control-Allow-Methods',
          'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        );
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      }
    }

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // For GET, prefer SSE when client accepts event-stream.
    const acceptsSSE = method === 'GET' && (req.headers.accept?.includes('text/event-stream') ?? false);
    const matched = acceptsSSE
      ? (app.match('SSE' as any, url.pathname) ?? app.match(method, url.pathname))
      : (app.match(method, url.pathname) ?? (method === 'GET' ? app.match('SSE' as any, url.pathname) : null));
    if (!matched) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    for (const handler of requestHandlers) {
      const handled = await handler(req, res, matched as any);
      if (handled) return;
    }

    let body: unknown = {};
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        body = await readBody(req, maxBodyBytes);
      } catch (err) {
        // Honor the statusCode the body parser attached (413 for over-limit,
        // 400 for invalid JSON). Without this, an oversize-body rejection
        // would surface as 400 instead of the documented 413.
        const status = (err as { statusCode?: number }).statusCode ?? 400;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
        // Now that the response is in flight, the request stream can be
        // safely destroyed to stop the client from uploading further.
        req.destroy();
        return;
      }
    }

    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    let responded = false;
    let pendingStatus = 200;

    const jsonResponse: JsonResponse = {
      json(data: unknown) {
        if (responded) return;
        responded = true;
        res.writeHead(pendingStatus, { 'Content-Type': 'application/json' });
        res.end(serializeJson(data));
        pendingStatus = 200;
      },
      html(content: string) {
        if (responded) return;
        responded = true;
        res.writeHead(pendingStatus, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
        pendingStatus = 200;
      },
      error(message: string, status = 400) {
        if (responded) return;
        responded = true;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      },
      status(code: number) {
        pendingStatus = code;
        return {
          json(data: unknown) {
            jsonResponse.json(data);
          },
          end() {
            if (responded) return;
            responded = true;
            res.writeHead(pendingStatus);
            res.end();
            pendingStatus = 200;
          },
        } as StatusedResponse<number, unknown>;
      },
    };

    try {
      const route = matched.route as any;
      if (route.steps && Array.isArray(route.steps)) {
        const ctx = {
          req,
          res: jsonResponse,
          params: route.types
            ? applyTypesConfig(matched.params, route.types)
            : matched.params,
          rawBody: body,
          rawQuery: query,
          headers: req.headers as Record<string, string>,
        };

        const completed = await executeRoute(route, ctx);

        if (!responded) {
          if (!completed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
          } else {
            res.writeHead(204);
            res.end();
          }
        }
      } else {
        await app.execute(matched, {
          params: matched.params,
          body,
          query,
          headers: req.headers as Record<string, string>,
          res: jsonResponse,
        });

        if (!responded) {
          res.writeHead(204);
          res.end();
        }
      }
    } catch (err) {
      if (!responded) {
        const statusCode = (err as any)?.statusCode;
        if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600) {
          jsonResponse.error((err as Error).message, statusCode);
        } else {
          console.error('Route error:', err);
          jsonResponse.error((err as Error).message, 500);
        }
      }
    }
  });

  server.on('upgrade', async (req, socket, head) => {
    for (const handler of upgradeHandlers) {
      try {
        const handled = await handler(req, socket, head);
        if (handled) return;
      } catch (err) {
        console.error('Upgrade handler error:', err);
        socket.destroy();
        return;
      }
    }
    socket.destroy();
  });

  server.listen(port);
  return server;
}
