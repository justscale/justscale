/**
 * AbstractContainer - queryable reflection of the current scope.
 *
 * Inject to introspect what the scope contains (controllers, services).
 * Each scope binds its own instance; sub-apps each get their own.
 * Transport-agnostic: protocols filter by reading their own metadata off
 * each controller instance.
 */

import { defineAbstract } from './service.js';
import type { ServiceToken } from './service.js';
import type { ControllerInstance } from './controller.js';

/**
 * Filter for `controllers(where?)`.
 */
export interface ControllerWhere {
  /**
   * If `true`, only include controllers whose routes declare any
   * `.guard(...)` step. If `false`, only unguarded controllers.
   * Useful for permission auditors.
   */
  readonly hasGuards?: boolean;
}

/**
 * Queryable container reflection. The framework provides the concrete
 * implementation - users never implement this directly.
 */
export interface ContainerReflection {
  /**
   * Iterate controllers in this scope, optionally filtered.
   * Iteration order is insertion order (stable across calls).
   */
  controllers(where?: ControllerWhere): Iterable<ControllerInstance>;

  /**
   * Resolve a service token in this scope. Returns `undefined` if not bound.
   */
  get<T>(token: ServiceToken<T>): Promise<T | undefined>;

  /**
   * Resolve every contribution bound to an abstract token in this scope.
   * Empty array if none bound. Used for the contribution pattern (e.g.
   * AbstractPrincipalProvider's multiple resolvers).
   */
  all<T>(token: ServiceToken<T>): Promise<ReadonlyArray<T>>;
}

/**
 * Abstract DI token for scope reflection. Tools inject this:
 *
 * @example
 * ```ts
 * class ApiDocService extends defineService({
 *   inject: { container: AbstractContainer },
 *   factory: ({ container }) => ({
 *     routes: () => [...container.controllers()],
 *   }),
 * }) {}
 * ```
 *
 * Each compiled scope binds its own concrete implementation.
 */
export abstract class AbstractContainer extends defineAbstract<ContainerReflection>('AbstractContainer') {}

/**
 * @internal Build a concrete ContainerReflection over a resolved app's
 * controllers and DI container.
 */
export function createContainerReflection(args: {
  readonly controllers: ReadonlyArray<ControllerInstance>;
  readonly resolve: <T>(token: ServiceToken<T>) => Promise<T | undefined>;
  readonly resolveAll?: <T>(token: ServiceToken<T>) => Promise<ReadonlyArray<T>>;
}): ContainerReflection {
  const { controllers, resolve, resolveAll } = args;

  return {
    *controllers(where) {
      for (const c of controllers) {
        if (where?.hasGuards !== undefined) {
          const anyGuard = c.routes.some((r) =>
            (r as unknown as { steps?: ReadonlyArray<{ type: string }> }).steps?.some(
              (s) => s.type === 'guard',
            ),
          );
          if (where.hasGuards !== anyGuard) continue;
        }
        yield c;
      }
    },

    async get<T>(token: ServiceToken<T>): Promise<T | undefined> {
      try {
        return await resolve(token);
      } catch {
        return undefined;
      }
    },

    async all<T>(token: ServiceToken<T>): Promise<ReadonlyArray<T>> {
      if (resolveAll) return resolveAll(token);
      const one = await this.get(token);
      return one === undefined ? [] : [one];
    },
  };
}
