/**
 * OpenAPI method registry - protocols self-describe how their route
 * methods surface in an OpenAPI 3.1 document.
 *
 * Each protocol package that wants to appear in OpenAPI specs registers
 * its method names on module load:
 *
 * ```ts
 * // @justscale/http
 * import { registerOpenApiMethod } from '@justscale/core';
 * for (const m of ['GET', 'POST', 'PUT', ...]) {
 *   registerOpenApiMethod(m, { httpMethod: m.toLowerCase() });
 * }
 *
 * // @justscale/sse
 * registerOpenApiMethod('SSE', {
 *   httpMethod: 'get',
 *   responseContentType: 'text/event-stream',
 * });
 * ```
 *
 * The OpenAPI generator (`@justscale/feature-openapi`) consults this
 * registry to decide (a) whether a route is documentable at all -
 * CLI / WebSocket / Event routes have no standard OpenAPI
 * representation, so they register nothing and get filtered out; and
 * (b) what HTTP method to emit under `paths` and which response
 * content type to advertise.
 *
 * Core knows nothing about HTTP or SSE directly - it just holds a
 * registry. Protocol packages own their own entries.
 */

/**
 * How a protocol's runtime method value maps onto OpenAPI 3.1 shape.
 */
export interface OpenApiMethodMapping {
  /**
   * OpenAPI operation verb - one of `get`, `post`, `put`, `patch`,
   * `delete`, `head`, `options`, `trace`. SSE-style protocols can
   * declare `httpMethod: 'get'` to be emitted as a GET with a custom
   * response content type.
   */
  readonly httpMethod: string;
  /**
   * Optional content type for the emitted response. Defaults to
   * `application/json` when unset. SSE sets this to
   * `text/event-stream`; future streaming-newline protocols might
   * use `application/x-ndjson`.
   */
  readonly responseContentType?: string;
}

const registry = new Map<string, OpenApiMethodMapping>();

/**
 * Register a protocol method name as OpenAPI-visible.
 * Duplicate registrations for the same method are ignored (first-win)
 * so two protocols claiming the same name can't step on each other.
 */
export function registerOpenApiMethod(
  method: string,
  mapping: OpenApiMethodMapping,
): void {
  if (!registry.has(method)) {
    registry.set(method, mapping);
  }
}

/** Resolve a runtime method value to its OpenAPI emission shape. */
export function getOpenApiMethodMapping(
  method: unknown,
): OpenApiMethodMapping | undefined {
  if (typeof method !== 'string') return undefined;
  return registry.get(method);
}

/** Snapshot of every registered method (for tests / debug). */
export function getRegisteredOpenApiMethods(): ReadonlyMap<
  string,
  OpenApiMethodMapping
> {
  return registry;
}
