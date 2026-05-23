/**
 * @justscale/core/plugin
 *
 * Base route factory system. This module provides the extensible
 * infrastructure for route factories. HTTP methods, Datastar routes,
 * and other route types are implemented as plugins.
 *
 * @example
 * ```typescript
 * import type { RouteHandler, RouteDef } from "@justscale/core/plugin";
 *
 * declare module "@justscale/core/plugin" {
 *   interface RouteFactories<TDeps> {
 *     MyRoute(path: string, handler: RouteHandler<TDeps>): RouteDef<TDeps>;
 *   }
 * }
 *
 * import { registerRouteFactory } from "@justscale/core/plugin";
 * registerRouteFactory("MyRoute", MyRoute);
 * ```
 */

import type { CliFactory } from '../cli/types.js';
import type {
  Middleware,
  Guard,
  MiddlewareDef,
  GuardDef,
} from './middleware.js';

// ============================================================================
// Path Parameter Extraction
// ============================================================================

/**
 * Extract parameter names from a path pattern.
 * "/users/:id" → { id: string }
 * "/users/:userId/posts/:postId" → { userId: string; postId: string }
 */
export type ExtractParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string } & ExtractParams<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : {};

/** Flatten intersection types for cleaner display */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

// ============================================================================
// Route Types
// ============================================================================

/**
 * Method metadata - describes characteristics of a route method.
 * Used by testing utilities, OpenAPI generation, etc.
 */
export interface MethodMetadata {
  /** Transport type (e.g., 'http', 'cli', 'event') */
  transport: string;
  /** Whether this method typically has a request body */
  hasBody?: boolean;
  /** Whether this method is idempotent */
  idempotent?: boolean;
}

/**
 * Extensible route method interface.
 * Transports extend this via module augmentation with metadata:
 *
 * @example
 * ```typescript
 * // In @justscale/http
 * declare module "@justscale/core" {
 *   interface SupportedMethods {
 *     GET: { transport: 'http'; hasBody: false; idempotent: true };
 *     POST: { transport: 'http'; hasBody: true; idempotent: false };
 *   }
 * }
 * ```
 */
export interface SupportedMethods {
  CLI: { transport: 'cli'; hasBody: false }
  // HTTP methods (merged from @justscale/http)
  GET: { transport: 'http'; hasBody: false; idempotent: true }
  POST: { transport: 'http'; hasBody: true; idempotent: false }
  PUT: { transport: 'http'; hasBody: true; idempotent: true }
  DELETE: { transport: 'http'; hasBody: false; idempotent: true }
  PATCH: { transport: 'http'; hasBody: true; idempotent: false }
  // Event methods (merged from @justscale/event)
  EVENT: { transport: 'event' }
  SUBSCRIBE: { transport: 'subscribe' }
  // WebSocket methods (merged from @justscale/websocket)
  WS: { transport: 'websocket'; hasBody: false; idempotent: false }
  // Procedure method (merged from controller/procedure.ts)
  PROCEDURE: { transport: 'procedure'; hasBody: true; idempotent: false }
  // Scheduled task method (merged from cluster/scheduled-task)
  SCHEDULED_TASK: { transport: 'scheduled-task' }
}

/**
 * Get metadata for a specific method.
 * @example
 * type PostMeta = GetMethodMetadata<'POST'>; // { transport: 'http'; hasBody: true; ... }
 */
export type GetMethodMetadata<M extends RouteMethod> = SupportedMethods[M];

/**
 * Check if a method has a request body.
 * @example
 * type PostHasBody = MethodHasBody<'POST'>; // true
 * type GetHasBody = MethodHasBody<'GET'>;   // false
 */
export type MethodHasBody<M extends RouteMethod> =
  SupportedMethods[M] extends { hasBody: infer H } ? H : false;

/**
 * Get all methods for a specific transport.
 * @example
 * type HttpMethods = MethodsForTransport<'http'>; // 'GET' | 'POST' | 'PUT' | ...
 */
export type MethodsForTransport<T extends string> = {
  [K in RouteMethod]: SupportedMethods[K] extends { transport: T } ? K : never;
}[RouteMethod];

/**
 * All registered route methods.
 * Transports add methods via module augmentation on SupportedMethods.
 */
export type RouteMethod = keyof SupportedMethods;


/** Base context available to all routes before middleware */
export interface BaseContext<
  TDeps = Record<string, unknown>,
  TParams = Record<string, string>
> {
  deps: TDeps;
  params: Prettify<TParams>;
}

/**
 * Route context interface - extensible by plugins.
 * Plugins can augment this interface to add transport-specific properties.
 */
export interface RouteContext<
  TDeps = Record<string, unknown>,
  TParams = Record<string, string>
> extends BaseContext<TDeps, TParams> {}

/** A route handler function */
export type RouteHandler<
  TDeps = Record<string, unknown>,
  TParams = Record<string, string>
> = (ctx: RouteContext<TDeps, TParams>) => void | Promise<void>;

// ============================================================================
// Route Builder
// ============================================================================

/**
 * Builder for composing routes with middleware and guards.
 * Each .use() call accumulates the context type.
 *
 * @example
 * ```typescript
 * // With raw functions
 * Get("/users/:id")
 *   .use(authMiddleware)
 *   .guard(isAuthenticated)
 *   .handle(({ params, user, stream }) => { ... })
 *
 * // With DI-enabled definitions
 * Get("/users/:id")
 *   .use(AuthMiddleware)  // MiddlewareDef
 *   .guard(IsAdmin)       // GuardDef
 *   .handle(({ params, user, stream }) => { ... })
 * ```
 */
export interface RouteBuilder<TDeps, TParams, TContext, TPath extends string = string, TBody = unknown, TResponse = unknown> {
  /**
   * Add middleware that extends the context.
   * Accepts either a middleware function or a MiddlewareDef (with DI).
   */
  use<TAdded extends object>(
    middleware: Middleware<TContext, TAdded>
  ): RouteBuilder<TDeps, TParams, Prettify<TContext & TAdded>, TPath, TBody, TResponse>;
  use<TAdded extends object>(
    middleware: MiddlewareDef<TAdded, any>
  ): RouteBuilder<TDeps, TParams, Prettify<TContext & TAdded>, TPath, TBody, TResponse>;

  /**
   * Add a guard that gates access to the route.
   * Accepts either a guard function or a GuardDef (with DI).
   */
  guard(check: Guard<TContext>): RouteBuilder<TDeps, TParams, TContext, TPath, TBody, TResponse>;
  guard(check: GuardDef<any>): RouteBuilder<TDeps, TParams, TContext, TPath, TBody, TResponse>;

  /**
   * Set the final handler for the route.
   * Receives the accumulated context from all middleware.
   */
  handle(
    handler: (ctx: TContext) => void | Promise<void>
  ): any;
}

// ============================================================================
// Extensible Route Factory Interface
// ============================================================================

/**
 * Extensible interface for route factories.
 * Plugins extend via declaration merging on "@justscale/core/plugin".
 */
export interface RouteFactories<TDeps> {
  /** CLI route factory - built-in since CLI is part of core */
  Cli: CliFactory<TDeps>
}

/** Registry for route factory implementations */
const routeFactoryRegistry = new Map<string, Function>();

/** Register a route factory (for plugins) */
export function registerRouteFactory(name: string, factory: Function): void {
  routeFactoryRegistry.set(name, factory);
}

/** Create all registered route factories with proper typing */
export function createRouteFactories<TDeps>(): RouteFactories<TDeps> {
  const factories: Record<string, Function> = {};
  for (const [name, factory] of routeFactoryRegistry) {
    factories[name] = factory;
  }
  return factories as unknown as RouteFactories<TDeps>;
}

// Re-export middleware types needed by plugin authors
export type {
  Middleware,
  Guard,
  MiddlewareDef,
  GuardDef,
  UnresolvedMiddleware,
  UnresolvedGuard,
} from './middleware.js';
