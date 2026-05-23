/**
 * Test App
 *
 * Create a testable app instance with access to internals.
 */

import type { App, MatchedRoute, ServiceToken, InstanceOf, ControllerDef } from '@justscale/core';
import { executeSteps } from '@justscale/core';
import { TestContainer } from './container.js';

/**
 * Extended App interface for testing with access to container and helpers.
 */
export interface TestApp extends App {
  /** The test container - allows mocking services */
  readonly testContainer: TestContainer;

  /**
   * Get typed access to a service from the container.
   *
   * @example
   * ```typescript
   * const userService = await app.service(UserService);
   * ```
   */
  service<T extends ServiceToken>(token: T): Promise<InstanceOf<T>>;

  /**
   * Mock a service with a partial implementation.
   *
   * @example
   * ```typescript
   * app.mock(UserRepository, {
   *   findById: mockFn().returns(Promise.resolve(null)),
   * });
   * ```
   */
  mock<T>(token: ServiceToken<T>, mockInstance: Partial<T>): TestApp;

  /**
   * Clear all mocks.
   */
  clearMocks(): TestApp;
}

/**
 * Configuration for creating a test app.
 */
export interface TestAppConfig {
  services?: ServiceToken[];
  controllers: ControllerDef<any>[];
}

/**
 * Create a test app with mock support.
 *
 * @example
 * ```typescript
 * const app = createTestApp({
 *   services: [UserRepository, UserService],
 *   controllers: [UsersController],
 * });
 *
 * // Mock a dependency
 * app.mock(UserRepository, {
 *   findById: mockFn().returns(Promise.resolve({ id: '1' })),
 * });
 *
 * // Access services
 * const userService = app.service(UserService);
 *
 * // Use the app for testing
 * const matched = app.match('GET', '/users/1');
 * ```
 */
export async function createTestApp(config: TestAppConfig): Promise<TestApp> {
  const container = new TestContainer();
  const controllers: any[] = [];

  // Register all services
  for (const service of config.services ?? []) {
    if (typeof service === 'function') {
      container.registerClass(service as any);
    } else {
      container.register(service as any);
    }
  }

  // Register and resolve controllers
  for (const controllerDef of config.controllers) {
    container.register(controllerDef as any);
    const instance = await container.resolve(controllerDef);
    controllers.push(instance);
  }

  function match(method: string, pathname: string): MatchedRoute | null {
    for (const controller of controllers) {
      for (const route of controller.routes) {
        if (route.method !== method) continue;

        const routeMatch = pathname.match(route.pattern);
        if (!routeMatch) continue;

        const params: Record<string, string> = {};
        route.paramNames.forEach((name: string, i: number) => {
          params[name] = routeMatch[i + 1] ?? '';
        });

        return { route, deps: controller.deps, params };
      }
    }
    return null;
  }

  async function execute(
    matched: MatchedRoute,
    contextAdditions: Record<string, unknown>
  ): Promise<unknown> {
    const { route, deps, params } = matched;

    const ctx: Record<string, unknown> = {
      deps,
      params,
      ...contextAdditions,
    };

    // Run steps (middleware + guards) via the canonical path that reads route.steps.
    // The old route.middlewares/route.guards fields are always [] after compilation.
    const passed = await executeSteps(route as any, ctx);
    if (!passed) {
      return undefined; // Guard denied
    }

    return route.handler(ctx);
  }

  const app: TestApp = {
    container,
    controllers,
    adapters: [],
    subApps: [],
    match,
    execute,
    ready: Promise.resolve(), // Test app is always ready immediately

    get testContainer() {
      return container;
    },

    service<T extends ServiceToken>(token: T): Promise<InstanceOf<T>> {
      return container.get(token);
    },

    mock<T>(token: ServiceToken<T>, mockInstance: Partial<T>): TestApp {
      container.mock(token, mockInstance);
      return app;
    },

    clearMocks(): TestApp {
      container.clearMocks();
      return app;
    },
  };

  return app;
}
