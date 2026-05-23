/**
 * Middleware & Guard Definitions
 *
 * Provides middleware and guard types with dependency injection support.
 */

import type { ServiceToken, ResolvedDeps } from './service.js';

// ============================================================================
// Middleware & Guards (Functions)
// ============================================================================

/**
 * Middleware function that can add properties to the context.
 * Returns an object that will be merged into the context.
 */
export type Middleware<TIn, TOut> = (ctx: TIn) => TOut | Promise<TOut>;

/**
 * Guard function that gates access to a route.
 * Returns true to allow, false to block (short-circuit).
 * Can also throw an error for custom error handling.
 */
export type Guard<TContext> = (ctx: TContext) => boolean | Promise<boolean>;

// ============================================================================
// Runtime Markers (declared first so interface __kind types can reference them)
// ============================================================================

/** Runtime marker for middleware definitions */
export const MIDDLEWARE_DEF_MARKER = Symbol('@justscale/middleware');

/** Runtime marker for guard definitions */
export const GUARD_DEF_MARKER = Symbol('@justscale/guard');

// ============================================================================
// Middleware & Guard Definitions (with DI)
// ============================================================================

/**
 * Middleware definition with dependency injection.
 * Like ServiceDef, but produces a middleware function.
 *
 * @example
 * ```typescript
 * const AuthMiddleware = createMiddleware({
 *   inject: { users: UserService, tokens: TokenService },
 *   handler: ({ users, tokens }) => async (ctx) => {
 *     const user = await tokens.validate(ctx.signals.token);
 *     return { user };  // Adds { user: User } to context
 *   }
 * });
 * ```
 */
export interface MiddlewareDef<
  TAdded extends object = object,
  TDeps extends Record<string, ServiceToken> = Record<string, ServiceToken>
> {
  readonly __kind: typeof MIDDLEWARE_DEF_MARKER;
  readonly deps: TDeps;
  readonly factory: (deps: ResolvedDeps<TDeps>) => Middleware<any, TAdded>;
}

/**
 * Guard definition with dependency injection.
 * Like ServiceDef, but produces a guard function.
 *
 * @example
 * ```typescript
 * const IsAdmin = createGuard({
 *   inject: { permissions: PermissionService },
 *   check: ({ permissions }) => async (ctx) => {
 *     return permissions.isAdmin(ctx.user);
 *   }
 * });
 * ```
 */
export interface GuardDef<
  TDeps extends Record<string, ServiceToken> = Record<string, ServiceToken>
> {
  readonly __kind: typeof GUARD_DEF_MARKER;
  readonly deps: TDeps;
  readonly factory: (deps: ResolvedDeps<TDeps>) => Guard<any>;
}

/** Check if value is a MiddlewareDef */
export function isMiddlewareDef(value: unknown): value is MiddlewareDef<any, any> {
  return typeof value === 'object' && value !== null && (value as any).__kind === MIDDLEWARE_DEF_MARKER;
}

/** Check if value is a GuardDef */
export function isGuardDef(value: unknown): value is GuardDef<any> {
  return typeof value === 'object' && value !== null && (value as any).__kind === GUARD_DEF_MARKER;
}

/**
 * Create a middleware with typed dependencies.
 *
 * @example
 * ```typescript
 * const AuthMiddleware = createMiddleware({
 *   inject: { tokens: TokenService },
 *   handler: ({ tokens }) => async (ctx) => {
 *     const user = await tokens.validate(ctx.signals.token);
 *     return { user };
 *   }
 * });
 * ```
 */
export function createMiddleware<
  const TDeps extends Record<string, ServiceToken>,
  TAdded extends object
>(config: {
  inject: TDeps;
  handler: (deps: ResolvedDeps<TDeps>) => Middleware<any, TAdded>;
}): MiddlewareDef<TAdded, TDeps> {
  return {
    __kind: MIDDLEWARE_DEF_MARKER,
    deps: config.inject,
    factory: config.handler,
  };
}

/**
 * Create a guard with typed dependencies.
 *
 * @example
 * ```typescript
 * const IsAdmin = createGuard({
 *   inject: { perms: PermissionService },
 *   check: ({ perms }) => (ctx) => perms.isAdmin(ctx.user)
 * });
 * ```
 */
export function createGuard<
  const TDeps extends Record<string, ServiceToken>
>(config: {
  inject: TDeps;
  check: (deps: ResolvedDeps<TDeps>) => Guard<any>;
}): GuardDef<TDeps> {
  return {
    __kind: GUARD_DEF_MARKER,
    deps: config.inject,
    factory: config.check,
  };
}

// ============================================================================
// Unresolved Types (for route builders)
// ============================================================================

/** Unresolved middleware - can be a function or a definition */
export type UnresolvedMiddleware = Middleware<any, any> | MiddlewareDef<any, any>;

/** Unresolved guard - can be a function or a definition */
export type UnresolvedGuard = Guard<any> | GuardDef<any>;

/** Extract the "added" type from a MiddlewareDef */
export type MiddlewareAdded<T> = T extends MiddlewareDef<infer A, any> ? A : never;

/** Input to .use() - either a function or a definition */
export type MiddlewareInput<TContext, TAdded extends object> =
  | Middleware<TContext, TAdded>
  | MiddlewareDef<TAdded, any>;

/** Input to .guard() - either a function or a definition */
export type GuardInput<TContext> =
  | Guard<TContext>
  | GuardDef<any>;
