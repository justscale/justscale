/**
 * Route Execution Runtime
 *
 * Executes a route with sequential middleware and guard execution.
 * Steps run in declaration order, with guards receiving stop() and
 * middleware extending context via Object.assign.
 */

import { isStop, createStopFn } from './stop.js';

/** Minimal interface for routes that executeRoute can process. */
interface ExecutableRoute {
  steps: Array<{ type: 'use' | 'guard'; fn: unknown }>;
  handler: (ctx: any) => any;
}

/**
 * Run only the middleware/guard steps for a route, without calling the handler.
 *
 * Used by protocols (SSE, etc.) that need to enforce guards but then drive the
 * handler themselves (e.g., an async generator that must stream back to a response).
 *
 * @param route - The finalized route definition (steps must be resolved)
 * @param ctx - Mutable context shared between steps (extended in-place by use steps)
 * @returns `true` if all steps passed, `false` if a guard denied the request.
 */
export async function executeSteps(
  route: Pick<ExecutableRoute, 'steps'>,
  ctx: Record<string, unknown>,
): Promise<boolean> {
  // Expose the route on the context so middleware/guards can introspect it.
  (ctx as any).__route = route;

  const steps = route.steps ?? [];
  for (const step of steps) {
    const fn = step.fn;
    if (typeof fn !== 'function') {
      throw new Error(
        'Route step has an unresolved dependency (GuardDef) — ' +
        'route steps must be resolved before execution. ' +
        'Ensure the route is registered via createController.',
      );
    }
    if (step.type === 'use') {
      const additions = await (fn as (ctx: any) => any)(ctx);
      Object.assign(ctx, additions);
    } else {
      const stop = createStopFn();
      (ctx as any).stop = stop;
      const result = await (fn as (ctx: any) => any)(ctx as any);
      delete (ctx as any).stop;
      if (isStop(result) || result === false) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Execute a route with the given context.
 * Steps run sequentially in declaration order.
 *
 * @param route - The finalized route definition (steps must be resolved, not GuardDefs)
 * @param ctx - Initial context (protocol provides res, req, params, etc.)
 * @returns `true` if all steps passed and the handler ran, `false` if a guard stopped execution.
 */
export async function executeRoute(
  route: ExecutableRoute,
  ctx: Record<string, unknown>
): Promise<boolean> {
  const passed = await executeSteps(route, ctx);
  if (!passed) return false;

  // All steps passed - run handler
  await route.handler(ctx);
  return true;
}
