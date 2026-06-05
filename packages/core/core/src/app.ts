/**
 * Application Bootstrap
 *
 * Creates and configures the application. Transport-agnostic - plugins provide protocol handling.
 */

import {
  Container,
  type ServiceToken,
  type ServiceDef,
  type ServiceClass,
  SERVICE_ID,
  getServiceProvides,
} from './core/service.js';
import { runInFullRequestScope, type RequestType } from './core/context.js';
import {
  type ControllerDef,
  type ControllerInstance,
  type CompiledRoute,
  collectBuiltins,
  registerBuiltinProvider,
} from './core/controller.js';
import {
  AbstractContainer,
  createContainerReflection,
} from './core/container-reflection.js';
import type { BaseContext } from './core/plugin.js';
import { _buildContext, type BuildContext } from './builder/build-context.js';
import type { Adapter } from './kernel/adapter.js';
import { getRegisteredTransports } from './cluster/cluster.js';
import { executeSteps } from './builder/execute.js';

registerBuiltinProvider(({ route, createLogger }) => ({
  logger: createLogger(route.name || 'handler'),
}));

/** Matched route with extracted params */
export interface MatchedRoute {
  route: CompiledRoute<any>;
  deps: Record<string, unknown>;
  params: Record<string, string>;
  /**
   * The container the matched route belongs to. Set when the match
   * came from a sub-app - `execute()` uses this to run the request
   * scope in the owning container, so sub-app handlers see their own
   * `getContainer()` / `getRequestContext()`.
   *
   * Undefined for routes matched in the parent's own controllers list;
   * `execute()` falls back to the parent container in that case.
   */
  owningContainer?: Container;
}

/** Options for route execution */
export interface ExecuteOptions {
  /** Defaults to 'http'. */
  requestType?: RequestType;
}

export interface App<TControllers extends ControllerDef<any>[] = ControllerDef<any>[]> {
  readonly container: Container;
  readonly controllers: ControllerInstance<any>[];

  readonly adapters: readonly Adapter[];

  /** @internal */
  readonly __buildContext?: BuildContext;

  /** Resolves when all controllers are resolved and the app is ready to handle requests. */
  readonly ready: Promise<void>;

  readonly subApps: readonly App<any>[];

  match(method: string, pathname: string): MatchedRoute | null;

  execute(
    matched: MatchedRoute,
    contextAdditions: Record<string, unknown>,
    options?: ExecuteOptions
  ): Promise<unknown>;
}

/** @internal */
interface AppCoreConfig {
  services?: ServiceToken[]
  controllers?: ControllerDef<any>[]
  _beforeControllerResolution?: (container: Container, controllers: ControllerDef<any>[]) => void
  _asyncBeforeControllerResolution?: (container: Container, controllers: ControllerDef<any>[]) => Promise<void>
  _getMatchDelegates?: () => ReadonlyArray<App<any>>
  _parentBuildContext?: BuildContext
}

function createAppCore(config: AppCoreConfig): App {
  const container = new Container();
  const controllers: ControllerInstance<any>[] = [];
  const installedAdapters = new Set<Adapter>();
  const buildCtx: BuildContext = config._parentBuildContext ?? {
    installAdapter: (a) => installedAdapters.add(a),
  };

  for (const service of config.services ?? []) {
    const isDefinedService = typeof service === 'function' && SERVICE_ID in service;

    if (typeof service === 'function' && !isDefinedService) {
      container.registerClass(service as ServiceClass);
    } else {
      const serviceDef = service as ServiceDef<unknown, any>;
      container.register(serviceDef);

      const provides = getServiceProvides(serviceDef);
      if (provides) {
        for (const providedToken of provides) {
          container.registerFor(providedToken, serviceDef);
        }
      }
    }
  }

  const allControllers = config.controllers ?? [];
  if (config._beforeControllerResolution) {
    config._beforeControllerResolution(container, allControllers);
  }

  for (const transport of getRegisteredTransports()) {
    if (transport.beforeControllerResolution) {
      transport.beforeControllerResolution(container, allControllers);
    }
  }

  container.registerInstance(
    AbstractContainer as unknown as ServiceToken<ReturnType<typeof createContainerReflection>>,
    createContainerReflection({
      controllers,
      resolve: <T>(token: ServiceToken<T>) =>
        container.resolve(token) as Promise<T | undefined>,
    }),
  );

  const ready = _buildContext.run(buildCtx, () => (async () => {
    if (config._asyncBeforeControllerResolution) {
      await config._asyncBeforeControllerResolution(container, allControllers);
    }

    // Swap in an app-bound LoggerFactory (pino with config / console / custom)
    // before anything resolves a Logger, so the whole app shares one backend.
    await container.resolveBoundLoggerFactory();

    const controllerPromises = (config.controllers ?? []).map(async (controllerDef) => {
      container.register(controllerDef as ServiceDef<unknown, any>);
      const instance = await container.resolve(controllerDef) as ControllerInstance<any>;
      (instance as any).__def = controllerDef;
      return instance;
    });

    const resolved = await Promise.all(controllerPromises);
    controllers.push(...resolved);

    await container.resolveAll();
    await container.wireModelPrototypes();
  })());

  function match(method: string, pathname: string): MatchedRoute | null {
    for (const controller of controllers) {
      for (const route of controller.routes) {
        if (route.method !== method) continue;

        const routeMatch = pathname.match(route.pattern);
        if (!routeMatch) continue;

        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = routeMatch[i + 1] ?? '';
        });

        return { route, deps: controller.deps, params };
      }
    }
    if (config._getMatchDelegates) {
      for (const delegate of config._getMatchDelegates()) {
        const sub = delegate.match(method, pathname);
        if (sub) {
          return {
            ...sub,
            owningContainer: sub.owningContainer ?? delegate.container,
          };
        }
      }
    }
    return null;
  }

  async function execute(
    matched: MatchedRoute,
    contextAdditions: Record<string, unknown>,
    options?: ExecuteOptions
  ): Promise<unknown> {
    const { route, deps } = matched;
    const requestType = options?.requestType ?? 'http';
    const scopeContainer = matched.owningContainer ?? container;

    return runInFullRequestScope(
      {
        container: scopeContainer,
        type: requestType,
        name: `${route.method} ${route.path}`,
        metadata: {
          [`${requestType}.method`]: route.method,
          [`${requestType}.route`]: route.path,
          'route.name': route.name,
        },
        observability: {
          route: route.name,
          method: route.method,
          path: route.path,
        },
      },
      async () => {
        const cleanupFns: Array<() => void | Promise<void>> = [];

        const onCleanup = (fn: () => void | Promise<void>) => {
          cleanupFns.push(fn);
        };

        const builtins = collectBuiltins({
          route,
          deps,
          createLogger: (context) => scopeContainer.createLogger(context),
        });

        // Build handler context - transport context + builtins only
        // Dependencies are accessed via closure capture from the routes function
        // Transport provides: params, body, query, res (for HTTP) via contextAdditions
        // Builtins (like logger) are always available via registered providers
        const ctx: Record<string, unknown> = {
          ...contextAdditions, // Transport-specific: params, res, body, query, etc.
          ...builtins,         // Builtin providers (logger, etc.)
          onCleanup,           // Cleanup registration
        };

        try {
          // Run steps (middleware + guards) via the canonical path that reads
          // route.steps, identical to how HTTP and CLI dispatch works.
          // route.middlewares / route.guards are always [] after compilation.
          const passed = await executeSteps(route as any, ctx);
          if (!passed) {
            return undefined; // Guard denied
          }

          // Call handler with full context
          return route.handler(ctx);
        } finally {
          for (let i = cleanupFns.length - 1; i >= 0; i--) {
            try {
              await cleanupFns[i]();
            } catch (cleanupError) {
              const logger = builtins.logger as { error?: (msg: string, meta?: unknown) => void } | undefined;
              logger?.error?.('Cleanup function threw', { error: cleanupError });
            }
          }
        }
      }
    );
  }

  const app: App = {
    container,
    controllers,
    get adapters(): readonly Adapter[] {
      return Array.from(installedAdapters);
    },
    __buildContext: buildCtx,
    get subApps(): readonly App<any>[] {
      return config._getMatchDelegates?.() ?? [];
    },
    ready: ready.then(() => {
      for (const transport of getRegisteredTransports()) {
        if (transport.onAppCreated) {
          transport.onAppCreated(app);
        }
      }
    }),
    match,
    execute,
  };

  return app;
}

/** @internal */
export function createAppInternal(config: AppCoreConfig): App {
  return createAppCore(config);
}
