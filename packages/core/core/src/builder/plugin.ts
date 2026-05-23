/**
 * Plugin System for Route Builder
 *
 * Plugins are reusable route transformations that can:
 * - Add middleware (use)
 * - Add guards
 * - Declare response types (returns)
 * - Require DI dependencies (inject)
 *
 * Dependencies are resolved lazily - when the controller registers with the container.
 */

import type { RouteBuilder } from './types.js';
import type { Container, ServiceToken, ResolvedDeps } from '../core/service.js';

// ============================================================================
// Plugin Symbol and Type Guard
// ============================================================================

/**
 * Symbol to identify plugins.
 * Brands plugin functions to distinguish them from regular callbacks.
 */
export const PLUGIN_SYMBOL = Symbol('justscale:plugin');

/**
 * Check if a value is a plugin.
 */
export function isPlugin(value: unknown): value is BuilderPlugin<any, any, any, any, any, any, any> {
  return typeof value === 'function' && (value as any)[PLUGIN_SYMBOL] === true;
}

// ============================================================================
// Plugin Interface
// ============================================================================

/**
 * A plugin is a function that transforms a RouteBuilder.
 * It can chain any combination of use/guard/returns.
 *
 * Plugins can optionally declare DI requirements which are resolved
 * when the controller registers with the container.
 *
 * @typeParam TCtxIn - Input context type
 * @typeParam TCtxOut - Output context type (after transformations)
 * @typeParam TRetIn - Input returns union
 * @typeParam TRetOut - Output returns union (after adding response types)
 * @typeParam TReqIn - Input DI requirements
 * @typeParam TReqOut - Output DI requirements (accumulated from this plugin)
 * @typeParam TPath - Route path literal
 */
export interface BuilderPlugin<
  TCtxIn,
  TCtxOut,
  TRetIn,
  TRetOut,
  TReqIn,
  TReqOut,
  TPath extends string,
  THandlerReturn = void | Promise<void>
> {
  (builder: RouteBuilder<TCtxIn, TRetIn, TReqIn, TPath, unknown, THandlerReturn>): RouteBuilder<TCtxOut, TRetOut, TReqOut, TPath, unknown, THandlerReturn>

  /** Brand to identify plugins */
  readonly [PLUGIN_SYMBOL]: true

  /** DI requirements (for type tracking) */
  readonly requirements?: TReqOut

  /** Resolve dependencies - called by controller at registration time */
  resolve?(container: Container): void
}

// ============================================================================
// Plugin Factory
// ============================================================================

/**
 * Create a reusable plugin with optional DI dependencies.
 *
 * Dependencies are resolved LAZILY - the plugin captures the build function,
 * and deps are resolved when controller.resolve() is called (at registration time).
 *
 * @example
 * ```typescript
 * // Plugin without dependencies
 * const addCors = () => createPlugin({
 *   build: () => builder => builder
 *     .use(ctx => ({ _cors: true }))
 *     .guard(ctx => {
 *       ctx.res.setHeader('Access-Control-Allow-Origin', '*')
 *     })
 * })
 *
 * // Plugin with DI dependencies
 * const requireAuth = () => createPlugin({
 *   inject: { auth: AuthService },
 *   build: ({ auth }) => builder => builder
 *     .returns(401, UnauthorizedSchema)
 *     .use(async ctx => {
 *       const token = ctx.headers.authorization?.replace('Bearer ', '')
 *       const session = token ? await auth.validate(token) : null
 *       return { _session: session }
 *     })
 *     .guard(ctx => {
 *       if (!ctx._session) {
 *         ctx.res.status(401).json({ message: 'Unauthorized' })
 *         return ctx.stop()
 *       }
 *     })
 *     .use(ctx => ({ session: ctx._session! }))
 * })
 * ```
 */
export function createPlugin<
  TDeps extends Record<string, ServiceToken<any>>,
  TCtxIn,
  TCtxOut,
  TRetIn,
  TRetOut
>(options: {
  /** DI dependencies required by this plugin */
  inject?: TDeps
  /** Build function that receives resolved dependencies and returns a builder transformer */
  build: (deps: ResolvedDeps<TDeps>) => <TPath extends string>(
    builder: RouteBuilder<TCtxIn, TRetIn, {}, TPath>
  ) => RouteBuilder<TCtxOut, TRetOut, {}, TPath>
}): BuilderPlugin<TCtxIn, TCtxOut, TRetIn, TRetOut, {}, TDeps, any> {

  // For plugins without deps, resolve immediately
  const hasDeps = options.inject && Object.keys(options.inject).length > 0;
  let resolvedDeps: ResolvedDeps<TDeps> | null = hasDeps ? null : ({} as ResolvedDeps<TDeps>);

  const plugin = ((builder: RouteBuilder<any, any, any, any>) => {
    if (!resolvedDeps) {
      throw new Error(
        'Plugin dependencies not resolved. ' +
        'This usually means the plugin was used before the controller registered with the container. ' +
        'Ensure the controller is properly registered before routes are defined.'
      );
    }
    return options.build(resolvedDeps)(builder);
  }) as BuilderPlugin<TCtxIn, TCtxOut, TRetIn, TRetOut, {}, TDeps, any>

  // Brand the plugin
  ;(plugin as any)[PLUGIN_SYMBOL] = true;

  // Attach requirements for type tracking
  if (options.inject) {
    ;(plugin as any).requirements = options.inject as TDeps;
  }

  // Resolution method - called by controller at registration time
  ;(plugin as any).resolve = (container: Container) => {
    if (options.inject) {
      const deps: Record<string, any> = {};
      for (const [key, token] of Object.entries(options.inject)) {
        deps[key] = container.resolve(token);
      }
      resolvedDeps = deps as ResolvedDeps<TDeps>;
    } else {
      // No dependencies - provide empty object
      resolvedDeps = {} as ResolvedDeps<TDeps>;
    }
  };

  return plugin;
}
