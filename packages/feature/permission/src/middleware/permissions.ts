/**
 * permissions middleware - resolves principals from the current request context
 * and wraps `res` with a `.permission` discriminant matching the route's
 * permission-scoped `.returns()` declarations.
 *
 * @example
 * ```typescript
 * Get('/employees/:employee')
 *   .types({ Employee })
 *   .use(auth)
 *   .use(permissions)
 *   .guard(Employee.can.view)
 *   .returns(200, EmployeeFull, Employee.can.fullAccess)
 *   .returns(200, EmployeeLimited, Employee.can.view)
 *   .handle(({ res }) => {
 *     switch (res.permission) {
 *       case 'fullAccess':
 *         res.json({ name, salary, department })
 *         return
 *       case 'view':
 *         res.json({ name })
 *         return
 *       default:
 *         assertNever(res)
 *     }
 *   })
 * ```
 */

import { createMiddleware, enterWithPrincipals, getAccessPrincipals } from '@justscale/core';
import { AbstractPrincipalProvider } from '../services/principal-provider.js';
import type { Principal, SinglePermissionDef } from '../types.js';

/** Shape of an entry in `route.permissionReturns`. */
interface PermissionReturnEntry {
  status: number;
  schema: unknown;
  permission: SinglePermissionDef;
}

/**
 * Find the first matching permission by invoking each permission's full
 * guard-check. Runs `.when(field)` / `.always()` / `.check(fn)` semantics,
 * not just a subject-class comparison. Declaration order wins.
 */
async function findMatchedPermission(
  entries: readonly PermissionReturnEntry[],
  ctx: unknown,
  provider: unknown,
): Promise<string | undefined> {
  for (const { permission } of entries) {
    const checkFn = permission.factory({ principals: provider } as any);
    const allowed = await checkFn(ctx as any);
    if (allowed) return permission.name;
  }
  return undefined;
}

/**
 * The permissions middleware.
 *
 * At runtime:
 * 1. Resolves principals via `AbstractPrincipalProvider`
 * 2. Stores principals in AsyncLocalStorage (for field-level access filtering)
 * 3. If the route has permission-scoped `.returns()`, determines the matched permission
 *    and wraps `ctx.res` with a `.permission` property
 *
 * The type-level wiring (narrowing `res.json()` based on `res.permission`) is handled
 * by the builder's `.returns(status, schema, permission)` overload.
 */
export const permissions = createMiddleware({
  inject: { provider: AbstractPrincipalProvider },
  handler: ({ provider }) => async (ctx: any) => {
    // Reuse principals if a prior middleware already resolved them.
    let principals = getAccessPrincipals() as readonly Principal[] | undefined;
    if (!principals) {
      principals = await provider.resolve(ctx);
      enterWithPrincipals(principals as any);
    }

    // Collect permission-scoped returns from the route - populated by the
    // builder when `.returns(status, schema, permission)` is called.
    const permReturns = ctx.__route?.permissionReturns as
      | readonly PermissionReturnEntry[]
      | undefined;

    let matchedPermission: string | undefined;
    if (permReturns && permReturns.length > 0) {
      matchedPermission = await findMatchedPermission(permReturns, ctx, provider);
    }

    // Wrap res with .permission (prototype chain preserves all res methods).
    // If no match, .permission is undefined - handler's switch will hit default.
    const wrappedRes = Object.assign(
      Object.create(ctx.res),
      matchedPermission !== undefined ? { permission: matchedPermission } : {},
    );

    return { res: wrappedRes, principals };
  },
});

/**
 * Type helper for exhaustiveness checking in switch/case.
 * Use in the `default` branch to catch unhandled permissions at compile time.
 *
 * @example
 * ```typescript
 * switch (res.permission) {
 *   case 'fullAccess': ...
 *   case 'view': ...
 *   default: assertNever(res)  // Compile error if a case is missing
 * }
 * ```
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled permission case: ${String(x)}`);
}
