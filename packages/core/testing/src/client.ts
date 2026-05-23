/**
 * Test Client
 *
 * Provides a base test client for testing JustScale applications.
 * Transport-specific functionality (HTTP, CLI, etc.) is added via explicit
 * transport configuration.
 */

import type { App, ServiceDef, Service, ControllerDef, ResponseEntry } from '@justscale/core';
import { Lifecycle, AbstractLockProvider, AbstractChannelBackend } from '@justscale/core';

/**
 * Drain an app's background work without going through BuiltApp.stop().
 * Tests use `JustScale().add(...).build().compile()` which returns the
 * raw App (no stop method); we replicate the kernel's teardown order so
 * the event loop drains and the test process can exit cleanly.
 *
 * Use this in tests that build an app directly (no TestClient) to avoid
 * the "Promise resolution still pending" file-level timeout.
 */
export async function teardownApp(app: App): Promise<void> {
  try {
    const lifecycle = await app.container.resolve(Lifecycle as never) as { runHook?: (name: 'stop') => Promise<void> };
    if (lifecycle && typeof lifecycle.runHook === 'function') {
      await lifecycle.runHook('stop');
    }
  } catch {
    // Lifecycle not registered — nothing to drain at this layer.
  }
  for (const token of [AbstractLockProvider, AbstractChannelBackend]) {
    try {
      const svc = await app.container.resolve(token as never) as { close?: () => Promise<void> };
      if (svc && typeof svc.close === 'function') await svc.close();
    } catch {
      // Provider not registered — skip.
    }
  }
}
import type { Ref } from '@justscale/core/models';

// ============================================================================
// Response Types
// ============================================================================

/**
 * Response from a test request.
 * Transports extend this with their specific fields.
 */
export interface TestResponse<T = unknown, TStatus extends number = number> {
  /** HTTP status code */
  status: TStatus;
  /** Parsed response data */
  data: T;
  /** Whether the request was successful (2xx status) */
  ok: TStatus extends 200 | 201 | 202 | 203 | 204 | 205 | 206 ? true : false;
}

// ============================================================================
// Type Utilities
// ============================================================================

type ServiceInstance<T> =
  T extends ServiceDef<infer S, any> ? S :
    T extends Service<infer S, any> ? S :
      never;

type AnyServiceDef = ServiceDef<any, any> | Service<any, any>;

type BuildServiceAPI<T extends Record<string, AnyServiceDef>> = {
  [K in keyof T]: ServiceInstance<T[K]>;
};

type ExtractPathParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string } & ExtractPathParams<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : {};

/**
 * Resolve the model class for a given path param, supporting lowercase matching.
 * `.types({ Campaign })` matches path param `:campaign` (lowercased key).
 */
type ResolveParamModel<
  ParamName extends string,
  TParamTypes extends Record<string, abstract new (...args: any[]) => any>,
> =
  { [K in keyof TParamTypes]: Lowercase<ParamName> extends Lowercase<K & string> ? TParamTypes[K] : never }[keyof TParamTypes];

/**
 * The type a client may pass for a path param.
 * If `.types({ Model })` declared the model for this param, accept a string OR
 * any Ref<Model> (Reference / Persistent / Locked) - the transport extracts
 * the identifier at runtime via refId().
 */
type ClientPathParamValue<
  ParamName extends string,
  TParamTypes extends Record<string, abstract new (...args: any[]) => any>,
> =
  [ResolveParamModel<ParamName, TParamTypes>] extends [never]
    ? string
    : string | Ref<InstanceType<Extract<ResolveParamModel<ParamName, TParamTypes>, abstract new (...args: any[]) => any>>>;

type ClientPathParams<Path extends string, TParamTypes extends Record<string, abstract new (...args: any[]) => any>> = {
  [K in keyof ExtractPathParams<Path>]: ClientPathParamValue<K & string, TParamTypes>
};

type JoinPath<TPrefix extends string, TPath extends string> =
  TPath extends '/'
    ? TPrefix extends '/' ? '/' : TPrefix
    : TPrefix extends '/'
      ? TPath
      : `${TPrefix}${TPath}`;

type Prettify<T> = { [K in keyof T]: T[K] } & {};
type IsEmptyObject<T> = keyof T extends never ? true : false;

// Convert ResponseEntry union to TestResponse discriminated union.
// Permission-scoped entries (3rd type param) collapse to their status+body
// pair - the client doesn't distinguish between permission variants.
// ResponseEntry<201, AuthResponse> | ResponseEntry<400, ErrorResponse>
// becomes: TestResponse<AuthResponse, 201> | TestResponse<ErrorResponse, 400>
type ResponseEntryToTestResponse<T> =
  T extends ResponseEntry<infer Status extends number, infer Body, any>
    ? TestResponse<Body, Status>
    : TestResponse<unknown>;

// Check if body type is known (not unknown)
type HasKnownBody<T> = unknown extends T ? false : true;

// Extract Returns type from RouteDefV2 via phantom _types property
type ExtractRouteReturns<T> =
  T extends { _types?: { returns: infer R } } ? R : unknown;

// Extract Body type from RouteDefV2 via phantom _types property
type ExtractRouteBody<T> =
  T extends { _types?: { body: infer B } } ? B : unknown;

// Extract paramTypes (the value passed to .types()) from RouteDefV2 via phantom _types.
// Used to widen path param inputs to accept Ref<Model> (not just string).
type ExtractRouteParamTypes<T> =
  T extends { _types?: { paramTypes: infer P } }
    ? P extends Record<string, abstract new (...args: any[]) => any>
      ? P
      : {}
    : {};

// For new format routes (RouteDefV2), now with proper body type support
// Returns a discriminated union of TestResponse based on status codes
type TypedRouteMethodV2<
  TPath extends string,
  TReturns,
  TBody,
  TParamTypes extends Record<string, abstract new (...args: any[]) => any> = {},
> =
  IsEmptyObject<ExtractPathParams<TPath>> extends true
    ? HasKnownBody<TBody> extends true
      ? (input: TBody) => Promise<ResponseEntryToTestResponse<TReturns>>
      : (input?: Record<string, unknown>) => Promise<ResponseEntryToTestResponse<TReturns>>
    : HasKnownBody<TBody> extends true
      ? (input: Prettify<ClientPathParams<TPath, TParamTypes> & TBody>) => Promise<ResponseEntryToTestResponse<TReturns>>
      : (input: Prettify<ClientPathParams<TPath, TParamTypes>> & Record<string, unknown>) => Promise<ResponseEntryToTestResponse<TReturns>>;

type RouteToMethod<TRoute, TPrefix extends string> =
  // New format (RouteDefV2) - has 'steps' property
  TRoute extends { path: infer Path extends string; steps: any[] }
    ? TypedRouteMethodV2<
      JoinPath<TPrefix, Path>,
      ExtractRouteReturns<TRoute>,
      ExtractRouteBody<TRoute>,
      ExtractRouteParamTypes<TRoute>
    >
    : never;

type ExtractPrefix<TSettings> =
  TSettings extends { prefix: infer P extends string } ? P : '/';

type ControllerMethods<TController> =
  TController extends ControllerDef<any, infer Routes, infer Settings>
    ? { [K in keyof Routes]: RouteToMethod<Routes[K], ExtractPrefix<Settings>> }
    : never;

/**
 * Build typed API from a controller mapping
 */
export type BuildControllerAPI<T extends Record<string, ControllerDef<any, any, any>>> = {
  [K in keyof T]: ControllerMethods<T[K]>;
};

// ============================================================================
// Transport Types
// ============================================================================

/**
 * Internal state passed to transports
 */
export interface TransportState {
  app: App<any>;
  cleanupFns: (() => Promise<void> | void)[];
}

/**
 * Base interface for a test transport.
 * Transports implement this to provide their functionality.
 */
export interface TestTransport<TTransportClient = unknown, TOptions = unknown> {
  /** Called during client creation to set up the transport */
  setup(state: TransportState, options?: TOptions): Promise<TTransportClient> | TTransportClient;
  /** Called during cleanup */
  cleanup?(transportClient: TTransportClient): Promise<void> | void;
}

/**
 * Extract the client type from a transport
 */
export type TransportClient<T> = T extends TestTransport<infer C, any> ? C : never;

/**
 * Extract options type from a transport
 */
export type TransportOptions<T> = T extends TestTransport<any, infer O> ? O : never;

// ============================================================================
// Test Client Interface
// ============================================================================

/**
 * Base test client interface.
 */
export interface TestClient<_TApp extends App<any> = App<any>> {
  /**
   * Get typed access to services from the app.
   *
   * @example
   * ```typescript
   * const { game, playerRepo } = await client.services({
   *   game: GameService,
   *   playerRepo: PlayerRepository,
   * });
   * ```
   */
  services<T extends Record<string, AnyServiceDef>>(
    mapping: T
  ): Promise<BuildServiceAPI<T>>;

  /** Close the test client and clean up resources */
  close(): Promise<void>;
}

/**
 * Test client with transport clients attached.
 * Each transport is accessible by its configured name.
 */
export type TestClientWithTransports<
  TApp extends App<any>,
  TTransports extends Record<string, TestTransport<any, any>>
> = TestClient<TApp> & {
  [K in keyof TTransports]: TransportClient<TTransports[K]>;
};

// ============================================================================
// Test Client Options
// ============================================================================

/**
 * Options for creating a test client.
 */
export interface TestClientOptions<
  TTransports extends Record<string, TestTransport<any, any>> = {}
> {
  /** Named transports to use */
  transports?: TTransports;
  /** Options passed to each transport (keyed by transport name) */
  transportOptions?: {
    [K in keyof TTransports]?: TransportOptions<TTransports[K]>;
  };
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a test client for testing JustScale applications.
 *
 * @example Without transports (services only)
 * ```typescript
 * const client = await createTestClient(app);
 * const { game } = await client.services({ game: GameService });
 * ```
 *
 * @example With HTTP transport
 * ```typescript
 * import { httpTransport } from '@justscale/http/testing';
 *
 * const client = await createTestClient(app, {
 *   transports: { http: httpTransport },
 *   transportOptions: { http: { port: 0 } }
 * });
 *
 * // Access typed controllers via HTTP
 * const { api } = client.http.useControllers({ player: PlayersController });
 * await api.player.list();
 *
 * // Raw HTTP calls
 * await client.http.get('/health');
 * ```
 */
export async function createTestClient<
  TApp extends App<any>,
  TTransports extends Record<string, TestTransport<any, any>> = {}
>(
  app: TApp,
  options: TestClientOptions<TTransports> = {}
): Promise<TestClientWithTransports<TApp, TTransports>> {
  const state: TransportState = {
    app,
    cleanupFns: [],
  };

  const transports = options.transports ?? ({} as TTransports);
  const transportOptions = options.transportOptions ?? {};
  const transportClients: Record<string, unknown> = {};

  // Set up each transport
  for (const [name, transport] of Object.entries(transports)) {
    const opts = (transportOptions as Record<string, unknown>)[name];
    const transportClient = await transport.setup(state, opts);
    transportClients[name] = transportClient;

    // Register cleanup if transport has it
    if (transport.cleanup) {
      const cleanup = transport.cleanup.bind(transport, transportClient);
      state.cleanupFns.push(cleanup);
    }
  }

  const client = {
    async services<T extends Record<string, ServiceDef<any, any>>>(
      mapping: T
    ): Promise<BuildServiceAPI<T>> {
      const services: Record<string, unknown> = {};

      for (const [name, serviceDef] of Object.entries(mapping)) {
        services[name] = await app.container.resolve(serviceDef);
      }

      return services as BuildServiceAPI<T>;
    },

    async close() {
      // Run transport cleanups first (close listening sockets, etc.)
      for (const cleanup of state.cleanupFns.reverse()) {
        await cleanup();
      }
      // Then stop the app — runs lifecycle stop hooks, drains channels,
      // releases lock-provider connections, stops durable processes.
      // Without this, every test leaks an app's worth of background
      // work; node:test's harness then waits for the event loop to
      // drain and reports "Promise resolution still pending" at the
      // file level.
      // Drain the app's background work. compile() returns App (no stop)
      // — we replicate the kernel teardown sequence inline:
      //   1. lifecycle stop hooks (cancels durable-process timers, etc.)
      //   2. close the lock provider (clears TTL setTimeouts)
      //   3. close the channel backend (closes pubsub LISTEN connection)
      // Without this, every test leaves an app's worth of timers and
      // connections holding the event loop open; node:test waits up to
      // its file-level timeout and reports "Promise resolution still
      // pending" even though the assertions all passed.
      await teardownApp(app);
    },

    // Spread transport clients
    ...transportClients,
  };

  return client as TestClientWithTransports<TApp, TTransports>;
}
