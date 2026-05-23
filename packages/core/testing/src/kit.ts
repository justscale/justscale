import JustScale from '@justscale/core';
import type { App, Builder, ControllerDef } from '@justscale/core';

type JustScaleBuilder = ReturnType<typeof JustScale>;
import {
  createTestClient,
  teardownApp,
  type TestClientOptions,
  type TestClientWithTransports,
  type TestTransport,
  type BuildControllerAPI,
} from './client.js';

/**
 * Builder factory: receives a fresh JustScale() builder (with the usual
 * built-ins already provided — Logger, Lifecycle), returns it decorated
 * with whatever the test wants. The returned Builder must have its
 * requires satisfied; we call `.build().compile()` on it.
 */
export type KitBuilderFn = (
  b: JustScaleBuilder,
) => { build: () => { compile: () => App } };

export interface SpawnHttpOptions<
  TTransports extends Record<string, TestTransport<unknown, unknown>>,
  TControllers extends Record<string, ControllerDef<any, any, any>>,
> extends TestClientOptions<TTransports> {
  /** Map of controller defs to surface as a typed `controllers` API. */
  controllers?: TControllers;
}

export interface SpawnHttpResult<
  TTransports extends Record<string, TestTransport<unknown, unknown>>,
  TControllers extends Record<string, ControllerDef<any, any, any>>,
> {
  app: App;
  client: TestClientWithTransports<App, TTransports>;
  controllers: BuildControllerAPI<TControllers>;
}

/**
 * Multi-instance test harness. Owns N apps, drains them on dispose.
 *
 * Auto-registers `afterEach` from node:test when available so tests
 * never have to remember cleanup; `using` / explicit `dispose()` are
 * supported as fallbacks (or for tests outside node:test).
 *
 * The framework's story is many-instance coordination — this kit
 * makes 1 the trivial case of N. `spawnCluster(N, builder)` is the
 * primitive for distributed-invariant tests (cross-instance lock,
 * cross-instance channel) that previously required ad-hoc worker
 * spawning.
 */
export interface TestKit {
  /** Build + compile one app. Adds it to the kit's owned set. */
  spawn(builderFn: KitBuilderFn): Promise<App>;

  /**
   * Build + compile one app AND attach test transport(s) for HTTP-style
   * testing. Returns a flat result: `{ app, client, controllers }`.
   * `controllers` is the typed surface for the controller defs you pass.
   */
  spawnHttp<
    TTransports extends Record<string, TestTransport<unknown, unknown>> = Record<string, never>,
    TControllers extends Record<string, ControllerDef<any, any, any>> = Record<string, never>,
  >(
    builderFn: KitBuilderFn,
    options?: SpawnHttpOptions<TTransports, TControllers>,
  ): Promise<SpawnHttpResult<TTransports, TControllers>>;

  /**
   * N identical instances. Use for distributed-invariant tests:
   * the apps share infrastructure (same Postgres, same Redis) so
   * coordination primitives (locks, channels) operate cross-instance.
   */
  spawnCluster(n: number, builderFn: KitBuilderFn): Promise<App[]>;

  /** Drain everything. Idempotent. */
  dispose(): Promise<void>;

  /** Apps owned by this kit (live + already-disposed are pruned). */
  readonly apps: readonly App[];

  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

export interface CreateTestKitOptions {
  /**
   * Whether to auto-register `afterEach` from node:test. Defaults to
   * true. Set to false for tests that manage their own lifecycle.
   */
  autoCleanup?: boolean;
}

/**
 * Create a multi-instance test harness. Call at module level (top of
 * a test file) so its `afterEach` runs after every test in the file.
 *
 * @example
 * ```ts
 * const kit = createTestKit()
 *
 * test('lock cross-instance', async () => {
 *   const [a, b] = await kit.spawnCluster(2, builder)
 *   // ... a holds lock, b times out, etc.
 * })
 * ```
 */
export function createTestKit(options?: CreateTestKitOptions): TestKit {
  const owned: Array<{ app: App; close: () => Promise<void> }> = [];
  let disposed = false;

  async function disposeAll(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    while (owned.length) {
      const entry = owned.pop()!;
      try {
        await entry.close();
      } catch (err) {
        errors.push(err);
      }
    }
    disposed = false; // allow re-spawn after manual dispose mid-test
    if (errors.length) {
      const first = errors[0];
      throw first instanceof Error ? first : new Error(String(first));
    }
  }

  if (options?.autoCleanup ?? true) {
    // node:test exposes `afterEach` as a top-level export; if we're
    // running outside node:test (e.g. a script), this import fails
    // silently and callers must dispose manually.
    void (async () => {
      try {
        const { afterEach } = await import('node:test');
        afterEach(async () => {
          await disposeAll();
        });
      } catch {
        // not in node:test context
      }
    })();
  }

  async function buildAndCompile(builderFn: KitBuilderFn): Promise<App> {
    const builder = builderFn(JustScale());
    const app = builder.build().compile();
    await app.ready;
    return app;
  }

  const kit: TestKit = {
    async spawn(builderFn) {
      const app = await buildAndCompile(builderFn);
      owned.push({ app, close: () => teardownApp(app) });
      return app;
    },

    async spawnHttp(builderFn, opts) {
      const app = await buildAndCompile(builderFn);
      const transports = opts?.transports ?? {};
      const transportOptions = opts?.transportOptions;
      const client = await createTestClient(app, {
        transports,
        transportOptions,
      } as TestClientOptions<Record<string, TestTransport<unknown, unknown>>>);
      // client.close() already calls teardownApp
      owned.push({ app, close: () => client.close() });

      const controllerDefs = (opts?.controllers ?? {}) as Record<string, ControllerDef<any, any, any>>;
      // useControllers lives on the http transport client; only available if the
      // caller wired the http transport.
      const httpClient = (client as unknown as Record<string, unknown>)['http'] as
        | { useControllers?: (m: Record<string, ControllerDef<any, any, any>>) => unknown }
        | undefined;
      const controllers =
        httpClient && typeof httpClient.useControllers === 'function' && Object.keys(controllerDefs).length
          ? (httpClient.useControllers(controllerDefs) as Record<string, unknown>)
          : ({} as Record<string, unknown>);

      return {
        app,
        client: client as TestClientWithTransports<App, Record<string, TestTransport<unknown, unknown>>>,
        controllers: controllers as never,
      } as never;
    },

    async spawnCluster(n, builderFn) {
      if (n < 1) return [];
      const results: App[] = [];
      // Sequential: deterministic ordering for distributed tests, and the
      // build phase is fast (DI graph, not network). Parallel build was
      // an option but it makes timing-sensitive tests harder to reason
      // about for trivial speedup.
      for (let i = 0; i < n; i++) {
        const app = await buildAndCompile(builderFn);
        owned.push({ app, close: () => teardownApp(app) });
        results.push(app);
      }
      return results;
    },

    dispose: disposeAll,

    get apps() {
      return owned.map((e) => e.app) as readonly App[];
    },

    [Symbol.asyncDispose]: () => disposeAll(),
  };

  return kit;
}
