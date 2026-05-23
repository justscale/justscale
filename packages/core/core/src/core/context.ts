/**
 * Request Context System
 *
 * Provides async context propagation for DI container access and request
 * chain tracing. Uses AsyncLocalStorage for automatic propagation.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Container } from './service.js';
import { runInScopeAsync, type ScopeInfo, type ObservabilityContext } from './logger.js';

// ============================================================================
// Container Context
// ============================================================================

const containerContext = new AsyncLocalStorage<Container>();

/**
 * Get the current DI container from async context.
 * Returns undefined if no container is in context.
 *
 * @example
 * ```typescript
 * const container = getContainer()
 * if (container) {
 *   const userService = await container.resolve(UserService)
 * }
 * ```
 */
export function getContainer(): Container | undefined {
  return containerContext.getStore();
}

/**
 * Get the current DI container, throwing if none is in context.
 * Use this when you require a container to be present.
 *
 * @throws Error if no container is in context
 *
 * @example
 * ```typescript
 * const container = requireContainer()
 * const userService = await container.resolve(UserService)
 * ```
 */
export function requireContainer(): Container {
  const container = getContainer();
  if (!container) {
    throw new Error('No container in context. Ensure code runs within request scope.');
  }
  return container;
}

/**
 * Run a function with a DI container in async context.
 * The container is available via getContainer() in the entire async tree.
 *
 * @example
 * ```typescript
 * runWithContainer(container, async () => {
 *   // getContainer() returns container here
 *   await processRequest()
 * })
 * ```
 */
export function runWithContainer<T>(container: Container, fn: () => T): T {
  return containerContext.run(container, fn);
}

// ============================================================================
// Request Chain Context
// ============================================================================

/**
 * Type of request/handler that initiated the context.
 */
export type RequestType = 'http' | 'ws' | 'cli' | 'event' | 'process' | 'scheduled' | 'internal';

/**
 * Context about the current request in the chain.
 * Forms a linked list back to the originating request.
 */
export interface RequestContext {
  /** Short unique identifier for this request */
  id: string
  /** Type of request handler */
  type: RequestType
  /** Name of the route/handler/process */
  name: string
  /** Parent request context (for chain tracing) */
  parent?: RequestContext
  /** When this request started */
  startedAt: Date
  /** Additional metadata (route params, user info, etc.) */
  metadata?: Record<string, unknown>
}

const requestContext = new AsyncLocalStorage<RequestContext>();

// ============================================================================
// Access Principal Type (for field-level access filtering)
// ============================================================================

/**
 * Minimal principal shape for access control evaluation.
 * Kept in core so both permission package (writer) and HTTP serializer (reader)
 * can use it without circular dependencies.
 */
export interface AccessPrincipal {
  readonly type: abstract new (...args: any[]) => any;
  readonly ref: { readonly identifier: string };
}

const principalContext = new AsyncLocalStorage<AccessPrincipal[]>();

/** Get the resolved principals for the current request (for field-level access filtering). */
export function getAccessPrincipals(): AccessPrincipal[] | undefined {
  return principalContext.getStore();
}

/** Run a function with resolved principals in context (set by permission guards). */
export function runWithPrincipals<T>(principals: AccessPrincipal[], fn: () => T): T {
  return principalContext.run(principals, fn);
}

/**
 * Set principals for the current async context (no callback needed).
 * Used by permission guards to make principals available for the rest of the request.
 */
export function enterWithPrincipals(principals: AccessPrincipal[]): void {
  principalContext.enterWith(principals);
}

/**
 * Get the current request context.
 * Returns undefined if not within a request scope.
 *
 * @example
 * ```typescript
 * const ctx = getRequestContext()
 * if (ctx) {
 *   console.log(`Request ${ctx.id} (${ctx.type}): ${ctx.name}`)
 * }
 * ```
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/**
 * Get the full request chain from current to origin.
 * Useful for debugging and distributed tracing.
 *
 * @example
 * ```typescript
 * const chain = getRequestChain()
 * // [current, parent, grandparent, ...]
 * console.log('Request chain:', chain.map(c => `${c.type}:${c.name}`).join(' -> '))
 * // "event:order.created -> http:POST /orders"
 * ```
 */
export function getRequestChain(): RequestContext[] {
  const chain: RequestContext[] = [];
  let current = getRequestContext();
  while (current) {
    chain.push(current);
    current = current.parent;
  }
  return chain;
}

/**
 * Run a function within a new request context.
 * Automatically links to parent context if one exists.
 */
export function runWithRequestContext<T>(
  type: RequestType,
  name: string,
  fn: () => T,
  metadata?: Record<string, unknown>
): T {
  const parent = getRequestContext();
  const ctx: RequestContext = {
    id: crypto.randomUUID().slice(0, 8),
    type,
    name,
    parent,
    startedAt: new Date(),
    metadata,
  };
  return requestContext.run(ctx, fn);
}

// ============================================================================
// Unified Request Scope
// ============================================================================

/**
 * Options for running code in a full request scope.
 */
export interface RequestScopeOptions {
  /** DI container for the request */
  container: Container
  /** Type of request/handler */
  type: RequestType
  /** Name of the route/handler */
  name: string
  /** Additional metadata */
  metadata?: Record<string, unknown>
  /** Observability context overrides */
  observability?: ObservabilityContext
}

/**
 * Run a function in a full request scope with container context,
 * request chain tracking, and observability instrumentation.
 */
export async function runInFullRequestScope<T>(
  options: RequestScopeOptions,
  fn: () => Promise<T>
): Promise<T> {
  const requestId = crypto.randomUUID().slice(0, 8);

  const scopeInfo: ScopeInfo = {
    type: options.type === 'http' ? 'request' : 'handler',
    name: options.name,
    attributes: options.metadata,
  };

  const observabilityCtx: ObservabilityContext = {
    requestId,
    ...options.observability,
  };

  return runWithContainer(options.container, () =>
    runWithRequestContext(options.type, options.name, () =>
      runInScopeAsync(scopeInfo, observabilityCtx, fn),
    options.metadata
    )
  );
}

/**
 * Synchronous version of runInFullRequestScope.
 * Use for synchronous handlers (rare).
 */
export function runInFullRequestScopeSync<T>(
  options: RequestScopeOptions,
  fn: () => T
): T {
  return runWithContainer(options.container, () =>
    runWithRequestContext(options.type, options.name, fn, options.metadata)
  );
}
