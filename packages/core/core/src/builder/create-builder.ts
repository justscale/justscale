/**
 * Route Builder Factory
 *
 * Provides the createBaseBuilder and createBuilderState functions
 * for constructing route builders with middleware/guard execution steps.
 */

import type { z } from 'zod';
import type { PermissionDefLike, RouteBuilder, UnresolvedStep } from './types.js';

/**
 * Internal state for building a route.
 */
export interface BuilderState {
  /** Sequential steps - use and guard interleaved (may contain unresolved GuardDefs) */
  steps: UnresolvedStep[]
  /** Response schemas mapped by status code */
  responseSchemas: Map<number, z.ZodType | null>
  /** Model types for path param → Reference transformation */
  types?: Record<string, abstract new (...args: any[]) => any>
  /** Permission-scoped returns - populated via `.returns(status, schema, permission)` */
  permissionReturns?: Array<{
    status: number
    schema: z.ZodType | null
    permission: PermissionDefLike
  }>
}

/**
 * Create initial builder state.
 */
export function createBuilderState(): BuilderState {
  return {
    steps: [],
    responseSchemas: new Map()
  };
}

/**
 * Create a base route builder.
 * This provides the core use/guard/apply/returns/handle methods.
 * Protocol-specific builders extend this.
 */
export function createBaseBuilder<TPath extends string, THandlerReturn = void | Promise<void>>(
  state: BuilderState,
  path: TPath
): RouteBuilder<{}, unknown, never, TPath, unknown, THandlerReturn> {

  const builder: RouteBuilder<any, any, any, any, any, any> = {
    use(middleware) {
      state.steps.push({ type: 'use', fn: middleware });
      return builder;
    },

    guard(check) {
      state.steps.push({ type: 'guard', fn: check });
      return builder;
    },

    apply(plugin) {
      // Plugin transforms builder, adding its own steps
      return plugin(builder);
    },

    returns(status: number, schema?: z.ZodType, permission?: PermissionDefLike) {
      state.responseSchemas.set(status, schema ?? null);
      if (permission) {
        state.permissionReturns ??= [];
        state.permissionReturns.push({
          status,
          schema: schema ?? null,
          permission,
        });
      }
      return builder;
    },

    types(types) {
      state.types = types;
      return builder;
    },

    handle(handler) {
      return {
        path,
        steps: [...state.steps],
        responseSchemas: new Map(state.responseSchemas),
        handler,
        ...(state.types ? { types: state.types } : {}),
        ...(state.permissionReturns && state.permissionReturns.length > 0
          ? { permissionReturns: [...state.permissionReturns] }
          : {}),
      };
    }
  };

  return builder;
}
