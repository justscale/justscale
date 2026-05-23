import type { App, ControllerDef } from '@justscale/core';
import { createConfig } from '@justscale/core';
import { isLocked, isPersistent, isReference, refId } from '@justscale/core/models';
import { HttpConfig } from './config.js';

/**
 * Default HttpConfig for tests - port 0 (random free port) + localhost.
 * Add to a test builder via `.add(defaultHttpConfig)` so compile-time checks
 * that require `Config.of(HttpConfig)` are satisfied without per-file env
 * wiring. Tests that exercise real network listeners can override the port.
 */
export const defaultHttpConfig = createConfig({
  provides: [HttpConfig],
  factory: () => ({
    [HttpConfig.key]: { port: 0, host: 'localhost' },
  }),
});

/**
 * Walk a body object and replace Reference / Persistent / Locked values
 * with their string identifiers, so the server's `z.ref(Model)` schema
 * receives the string form it accepts.
 *
 * The path-param pipeline already does this per-key; body fields need
 * the same treatment because Reference's identifier is exposed as a
 * getter (not enumerable), so plain JSON.stringify produces '{}' and
 * Persistent entities get serialized by their domain fields - neither
 * matches the z.ref schema.
 */
function unwrapRefs(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isReference(value) || isPersistent(value) || isLocked(value)) {
    return refId(value);
  }
  if (Array.isArray(value)) return value.map(unwrapRefs);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = unwrapRefs(v);
  }
  return out;
}
import type {
  BuildControllerAPI,
  TestResponse,
  TestTransport,
  TransportState,
} from '@justscale/testing';
import { listen } from './server.js';

// ============================================================================
// Module Augmentation - Extend TestResponse with HTTP-specific fields
// ============================================================================

declare module '@justscale/testing' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface TestResponse<T = unknown, TStatus extends number = number> {
    /** Response headers */
    headers: Headers
    /** Raw response text */
    text: string
  }
}

// ============================================================================
// HTTP Transport Options
// ============================================================================

export interface HttpTransportOptions {
  /** Port to run the test server on (0 = random available port) */
  port?: number
}

// ============================================================================
// HTTP Transport Client
// ============================================================================

/** Request function type */
export type HttpRequestFn = <T = unknown>(
  path: string,
  options?: RequestInit,
) => Promise<HttpTestResponse<T>>;

/**
 * Typed API returned by useControllers().
 * Stateless - use createUserSession() to add auth state.
 */
export interface TypedApi<
  T extends Record<string, ControllerDef<any, any, any>>,
> {
  /** The typed controller methods */
  readonly api: BuildControllerAPI<T>
  /** The controller mapping (for createUserSession) */
  readonly _controllers: T
  /** The HTTP client (for createUserSession) */
  readonly _http: HttpTransportClient
}

/**
 * HTTP transport client returned by the transport.
 * Provides HTTP methods and typed controller access.
 */
export interface HttpTransportClient {
  /** Base URL of the test server */
  readonly baseUrl: string

  /**
   * Declare controllers for typed access.
   * Returns a stateless typed API - use createUserSession() to add auth.
   *
   * @example
   * ```typescript
   * const api = client.http.useControllers({
   *   auth: AuthHttpController,
   *   protected: ProtectedController,
   * });
   *
   * // Stateless calls (no auth)
   * await api.auth.register({ email, password });
   *
   * // Or wrap with createUserSession for auth state
   * const user = createUserSession(api);
   * ```
   */
  useControllers<const T extends Record<string, ControllerDef<any, any, any>>>(
    mapping: T,
  ): TypedApi<T>

  /**
   * Get typed access to controllers with a custom request function.
   * Used internally by createUserSession.
   * @internal
   */
  controllersWithRequest<
    const T extends Record<string, ControllerDef<any, any, any>>,
  >(mapping: T, requestFn: HttpRequestFn): BuildControllerAPI<T>

  /** Make a GET request */
  get<T = unknown>(path: string): Promise<HttpTestResponse<T>>

  /** Make a POST request */
  post<T = unknown>(path: string, body?: unknown): Promise<HttpTestResponse<T>>

  /** Make a PUT request */
  put<T = unknown>(path: string, body?: unknown): Promise<HttpTestResponse<T>>

  /** Make a PATCH request */
  patch<T = unknown>(path: string, body?: unknown): Promise<HttpTestResponse<T>>

  /** Make a DELETE request */
  delete<T = unknown>(path: string): Promise<HttpTestResponse<T>>

  /** Make a custom HTTP request */
  request<T = unknown>(
    path: string,
    options?: RequestInit,
  ): Promise<HttpTestResponse<T>>
}

/**
 * HTTP-specific test response with status and headers.
 */
export interface HttpTestResponse<T = unknown> extends TestResponse<T> {
  /** HTTP status code */
  status: number
  /** Response headers */
  headers: Headers
  /** Raw response text */
  text: string
}

// ============================================================================
// Transport Implementation
// ============================================================================

/**
 * HTTP transport for testing.
 *
 * @example
 * ```typescript
 * import { createTestClient } from '@justscale/testing';
 * import { httpTransport } from '@justscale/http/testing';
 *
 * const client = await createTestClient(app, {
 *   transports: { http: httpTransport },
 *   transportOptions: { http: { port: 0 } }
 * });
 *
 * // Typed controller access
 * const api = client.http.controllers({ player: PlayersController });
 * const { status, data } = await api.player.list();
 *
 * // Raw HTTP calls
 * await client.http.get('/health');
 * await client.http.post('/players', { name: 'Alice' });
 *
 * await client.close();
 * ```
 */
export const httpTransport: TestTransport<
  HttpTransportClient,
  HttpTransportOptions
> = {
  async setup(
    state: TransportState,
    options?: HttpTransportOptions,
  ): Promise<HttpTransportClient> {
    const port = options?.port ?? 0;
    const server = listen(state.app as App<any>, port);

    // Wait for server to start
    const actualPort = await new Promise<number>((resolve, reject) => {
      server.on('listening', () => {
        const address = server.address();
        if (typeof address === 'object' && address) {
          resolve(address.port);
        } else {
          reject(new Error('Could not determine server port'));
        }
      });
      server.on('error', reject);
    });

    const baseUrl = `http://localhost:${actualPort}`;

    // Register cleanup
    state.cleanupFns.push(() => {
      return new Promise<void>((resolve, reject) => {
        // closeAllConnections() forces keep-alive sockets to terminate.
        // Without this, server.close() waits for idle connections to
        // hit their keep-alive timeout (default 5s) before resolving,
        // leaking the Server handle into the event loop and surfacing
        // as "Promise resolution still pending" at file-level teardown.
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close((err: Error | undefined) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

    // Request helper
    async function request<T = unknown>(
      path: string,
      options: RequestInit = {},
    ): Promise<HttpTestResponse<T>> {
      const url = `${baseUrl}${path}`;

      const res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      const text = await res.text();
      let data: T;
      try {
        data = JSON.parse(text);
      } catch {
        data = text as unknown as T;
      }

      return {
        status: res.status,
        headers: res.headers,
        data,
        text,
        ok: res.ok as HttpTestResponse<T>['ok'],
      };
    }

    // Build controller proxy with a given request function
    function buildControllerProxy(
      controllerDef: ControllerDef<any, any, any>,
      requestFn: typeof request = request,
    ): Record<string, Function> {
      const proxy: Record<string, Function> = {};

      // Match by controller def identity - the app tags each resolved
      // instance with `__def`. Prefix-based matching was broken because
      // multiple controllers can share (or omit) a prefix.
      const controller = state.app.controllers.find(
        (c: any) => c.__def === controllerDef,
      );
      if (!controller) {
        throw new Error(
          `Controller not registered in app (prefix="${(controllerDef as any).prefix ?? ''}")`,
        );
      }

      for (const route of controller.routes) {
        proxy[route.name] = async (input?: Record<string, unknown>) => {
          const method = route.method;
          let path = route.path;

          const pathParams = route.paramNames;
          let remaining: Record<string, unknown> | undefined;

          if (input) {
            remaining = { ...input };
            for (const param of pathParams) {
              if (param in input) {
                // Accept string, Reference, or Persistent - extract the id.
                const value = input[param];
                const id =
                  typeof value === 'string' ? value : refId(value);
                path = path.replace(`:${param}`, id);
                delete remaining[param];
              }
            }
            if (Object.keys(remaining).length === 0) {
              remaining = undefined;
            }
          }

          if (method === 'GET') {
            // For GET, remaining params become query string
            if (remaining && Object.keys(remaining).length > 0) {
              const queryString = new URLSearchParams(
                Object.entries(remaining).map(([k, v]) => [k, String(v)]),
              ).toString();
              path = `${path}?${queryString}`;
            }
            return requestFn(path, { method });
          }
          // For DELETE, POST, PUT, PATCH - send body. Unwrap any Ref /
          // Persistent / Locked values to their string identifiers before
          // JSON.stringify, so z.ref() on the server side accepts them.
          return requestFn(path, {
            method,
            body:
              remaining !== undefined
                ? JSON.stringify(unwrapRefs(remaining))
                : undefined,
          });
        };
      }

      return proxy;
    }

    // Build controllers with optional custom request function
    function buildControllers<
      T extends Record<string, ControllerDef<any, any, any>>,
    >(mapping: T, requestFn: typeof request = request): BuildControllerAPI<T> {
      const api: Record<string, Record<string, Function>> = {};

      for (const [name, controllerDef] of Object.entries(mapping)) {
        api[name] = buildControllerProxy(controllerDef, requestFn);
      }

      return api as BuildControllerAPI<T>;
    }

    // Create transport client
    const transportClient: HttpTransportClient = {
      baseUrl,

      useControllers<T extends Record<string, ControllerDef<any, any, any>>>(
        mapping: T,
      ): TypedApi<T> {
        return {
          api: buildControllers(mapping, request),
          _controllers: mapping,
          _http: transportClient,
        };
      },

      controllersWithRequest<
        T extends Record<string, ControllerDef<any, any, any>>,
      >(mapping: T, requestFn: HttpRequestFn): BuildControllerAPI<T> {
        return buildControllers(mapping, requestFn);
      },

      get<T = unknown>(path: string) {
        return request<T>(path, { method: 'GET' });
      },

      post<T = unknown>(path: string, body?: unknown) {
        return request<T>(path, {
          method: 'POST',
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      },

      put<T = unknown>(path: string, body?: unknown) {
        return request<T>(path, {
          method: 'PUT',
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      },

      patch<T = unknown>(path: string, body?: unknown) {
        return request<T>(path, {
          method: 'PATCH',
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      },

      delete<T = unknown>(path: string) {
        return request<T>(path, { method: 'DELETE' });
      },

      request,
    };

    return transportClient;
  },
};

// ============================================================================
// User Session (Stateful Auth Wrapper)
// ============================================================================

/**
 * Session state for tracking cookies and tokens.
 */
export interface UserSessionState {
  /** JWT or bearer token */
  token: string | null
  /** Cookie jar */
  cookies: Map<string, string>
}

/**
 * Options for createUserSession.
 */
export interface UserSessionOptions<
  _T extends Record<string, ControllerDef<any, any, any>>,
> {
  /**
   * Auto-capture token from responses.
   * Called after each API call - return a token to store it.
   *
   * @example
   * ```typescript
   * captureToken: (route, response) => {
   *   if (route === 'auth.register' || route === 'auth.login') {
   *     return response.data.token;
   *   }
   * }
   * ```
   */
  captureToken?: (
    route: string,
    response: HttpTestResponse<any>,
  ) => string | undefined
}

/**
 * A user session - typed API with auth state.
 * Each session tracks its own token/cookies independently.
 */
export interface UserSession<
  T extends Record<string, ControllerDef<any, any, any>>,
> {
  /** Typed controller access with auth automatically applied */
  readonly api: BuildControllerAPI<T>

  /** Current token (null if not set) */
  readonly token: string | null

  /** Set the bearer token for subsequent requests */
  setToken(token: string | null): void

  /** Set a cookie for subsequent requests */
  setCookie(name: string, value: string): void

  /** Get a cookie value */
  getCookie(name: string): string | undefined

  /** Clear all auth state (token and cookies) */
  clearAuth(): void

  /** Get current session state (for debugging) */
  getState(): Readonly<UserSessionState>
}

/**
 * Parse Set-Cookie header and store cookies.
 */
function parseSetCookie(header: string, cookies: Map<string, string>): void {
  // Simple parser - handles "name=value" part, ignores attributes
  const parts = header.split(';');
  if (parts.length > 0) {
    const [nameValue] = parts;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx > 0) {
      const name = nameValue.slice(0, eqIdx).trim();
      const value = nameValue.slice(eqIdx + 1).trim();
      cookies.set(name, value);
    }
  }
}

/**
 * Create a user session with auth state.
 *
 * Each session independently tracks its own token and cookies,
 * allowing multi-user test scenarios.
 *
 * @example
 * ```typescript
 * import { createTestClient } from '@justscale/testing';
 * import { httpTransport, createUserSession } from '@justscale/http/testing';
 * import { AuthHttpController } from '@justscale/feature-auth';
 *
 * const client = await createTestClient(app, {
 *   transports: { http: httpTransport },
 * });
 *
 * // Step 1: Declare controllers for typing
 * const api = client.http.useControllers({
 *   auth: AuthHttpController,
 *   protected: ProtectedController,
 * });
 *
 * // Step 2: Create user sessions
 * const alice = createUserSession(api);
 * const bob = createUserSession(api);
 *
 * // Alice registers - token auto-captured
 * const aliceRes = await alice.api.auth.register({
 *   email: 'alice@test.com',
 *   password: 'password123',
 * });
 * alice.setToken(aliceRes.data.token);
 *
 * // Bob registers separately
 * const bobRes = await bob.api.auth.register({
 *   email: 'bob@test.com',
 *   password: 'password123',
 * });
 * bob.setToken(bobRes.data.token);
 *
 * // Each user acts independently
 * await alice.api.protected.profile(); // Alice's profile
 * await bob.api.protected.profile();   // Bob's profile
 *
 * // Can also auto-capture tokens
 * const user = createUserSession(api, {
 *   captureToken: (route, res) => {
 *     if (route === 'auth.register' || route === 'auth.login') {
 *       return res.data.token;
 *     }
 *   }
 * });
 * await user.api.auth.register({ email, password }); // Token auto-stored!
 * await user.api.protected.profile(); // Already authenticated
 * ```
 */
export function createUserSession<
  T extends Record<string, ControllerDef<any, any, any>>,
>(typedApi: TypedApi<T>, options?: UserSessionOptions<T>): UserSession<T> {
  const { _controllers: controllers, _http: http } = typedApi;

  const state: UserSessionState = {
    token: null,
    cookies: new Map(),
  };

  // Wrap request to add auth and capture cookies
  async function wrappedRequest<TData = unknown>(
    path: string,
    opts: RequestInit = {},
  ): Promise<HttpTestResponse<TData>> {
    const headers: Record<string, string> = {
      ...((opts.headers as Record<string, string>) || {}),
    };

    // Add Authorization header if token is set
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }

    // Add cookies if any
    if (state.cookies.size > 0) {
      const cookieHeader = [...state.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
      headers.Cookie = cookieHeader;
    }

    const res = await http.request<TData>(path, {
      ...opts,
      headers,
    });

    // Capture Set-Cookie headers
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      parseSetCookie(setCookie, state.cookies);
    }

    return res;
  }

  // Build auth-aware API proxy
  function buildAuthApi(): BuildControllerAPI<T> {
    const baseApi = http.controllersWithRequest(controllers, wrappedRequest);

    // If captureToken is provided, wrap each method to auto-capture
    if (!options?.captureToken) {
      return baseApi;
    }

    const wrappedApi: Record<string, Record<string, Function>> = {};

    for (const [controllerName, controllerMethods] of Object.entries(baseApi)) {
      wrappedApi[controllerName] = {};
      for (const [methodName, method] of Object.entries(
        controllerMethods as Record<string, Function>,
      )) {
        wrappedApi[controllerName][methodName] = async (...args: unknown[]) => {
          const result = await (method as Function)(...args);
          const routeKey = `${controllerName}.${methodName}`;
          const capturedToken = options.captureToken!(routeKey, result);
          if (capturedToken) {
            state.token = capturedToken;
          }
          return result;
        };
      }
    }

    return wrappedApi as BuildControllerAPI<T>;
  }

  return {
    get api() {
      return buildAuthApi();
    },

    get token() {
      return state.token;
    },

    setToken(token: string | null) {
      state.token = token;
    },

    setCookie(name: string, value: string) {
      state.cookies.set(name, value);
    },

    getCookie(name: string) {
      return state.cookies.get(name);
    },

    clearAuth() {
      state.token = null;
      state.cookies.clear();
    },

    getState() {
      return {
        token: state.token,
        cookies: new Map(state.cookies),
      };
    },
  };
}
