/**
 * byPermissions() - derive a WHERE condition from a model's `can` map.
 *
 * Finds all queryable `when`/`always` permissions in the `can` map whose
 * `subjectClass` matches the given principal, then ORs them together.
 * Non-queryable permissions (`check`, `explicit`) are ignored.
 *
 * @example
 * ```typescript
 * import { byPermissions } from '@justscale/permission'
 *
 * // Find all products the seller can edit
 * const products = await productRepo.find({
 *   where: byPermissions(Product.can, { type: Seller, ref: sellerRef }),
 * });
 *
 * // Combine with other conditions
 * const cheapOnes = await productRepo.find({
 *   where: q.and(
 *     byPermissions(Product.can, { type: Seller, ref: sellerRef }),
 *     Product.fields.price.lt(10),
 *   ),
 * });
 * ```
 */

import { q } from '@justscale/core/models';
import type { Condition } from '@justscale/core/models';
import type { AnyPermissionDef, Principal, QueryablePermissionDef, SinglePermissionDef } from './types.js';
import { isQueryablePermissionDef } from './types.js';

/**
 * Collect all queryable permission defs from a can map value that match the given principal.
 * Returns an array of QueryablePermissionDef for ORing together.
 */
function collectMatchingQueryable(
  permission: SinglePermissionDef | readonly SinglePermissionDef[],
  principal: Principal,
): QueryablePermissionDef[] {
  const perms: SinglePermissionDef[] = Array.isArray(permission)
    ? (permission as SinglePermissionDef[])
    : [permission as SinglePermissionDef];

  return perms.filter(
    (p): p is QueryablePermissionDef =>
      isQueryablePermissionDef(p) &&
      (p.subjectClass === principal.type || principal.type.prototype instanceof (p.subjectClass as any)),
  );
}

/**
 * Derive a WHERE condition from a model's `can` map for the given principal.
 *
 * Merges all matching queryable permissions for the same action with OR logic,
 * and merges across actions with OR logic too.
 *
 * If no matching permissions are found, returns `q.or()` (empty OR = FALSE = no access).
 *
 * @param can - The model's `can` map (e.g. `Product.can`)
 * @param principal - The principal to check access for
 * @param action - Optional: restrict to a specific action key. If omitted, all actions are merged.
 */
export function byPermissions(
  can: Record<string, AnyPermissionDef | readonly SinglePermissionDef[]>,
  principal: Principal,
  action?: string,
): Condition {
  const conditions: Condition[] = [];

  const entries = action ? [[action, can[action]] as const] : Object.entries(can);

  const seen = new Set<string>();

  for (const [, permission] of entries) {
    if (!permission) continue;

    const matching = collectMatchingQueryable(
      permission as SinglePermissionDef | readonly SinglePermissionDef[],
      principal,
    );

    for (const perm of matching) {
      const cond = perm.toCondition(principal);
      const key = JSON.stringify(cond);
      if (seen.has(key)) continue;
      seen.add(key);
      conditions.push(cond);
    }
  }

  if (conditions.length === 0) {
    // No matching permissions: OR with empty conditions = FALSE (deny all)
    return q.or();
  }

  if (conditions.length === 1) {
    return conditions[0];
  }

  return q.or(...conditions);
}
