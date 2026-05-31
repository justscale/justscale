/**
 * PermissionService - grant, revoke, and check explicit permission grants.
 *
 * This service manages explicit PermissionGrant records.
 * It is used when a principal needs access beyond what `.when()` or `.always()` rules provide,
 * for instance when a Seller explicitly shares edit access with another Seller.
 *
 * @example
 * ```typescript
 * // Grant Seller B access to edit Seller A's product
 * await permissions.grant(Product.can.edit, {
 *   subject: Seller.ref(sellerB),
 *   resource: Product.ref(product),
 * });
 *
 * // Check if a principal has explicit access
 * const allowed = await permissions.check(Product.can.edit, {
 *   subject: Seller.ref(sellerA),
 *   resource: Product.ref(product),
 * });
 *
 * // Revoke
 * await permissions.revoke(Product.can.edit, {
 *   subject: Seller.ref(sellerB),
 *   resource: Product.ref(product),
 * });
 * ```
 */

import { defineService } from '@justscale/core';
import { ModelRepository, q } from '@justscale/core/models';
import type { Reference } from '@justscale/core/models';
import { PermissionGrant } from '../models/permission-grant.js';
import type { SinglePermissionDef } from '../types.js';

/**
 * WeakMap-based identity registry for subject classes.
 * Avoids collisions between two unrelated classes that share the same `.name`
 * (e.g., two packages each defining a `Seller` model in the same process).
 * Each class gets a unique monotonic ID on first reference; the string is
 * stable for the lifetime of the process but not persisted to storage.
 */
const classIdMap = new WeakMap<abstract new (...args: any[]) => any, string>();
let classIdCounter = 0;

function classId(cls: abstract new (...args: any[]) => any): string {
  let id = classIdMap.get(cls);
  if (!id) {
    id = `${cls.name}#${++classIdCounter}`;
    classIdMap.set(cls, id);
  }
  return id;
}

/** Stable action key for a permission - uses class identity, not just .name. */
function actionKey(permission: SinglePermissionDef, actionName: string): string {
  return `${classId(permission.subjectClass)}:${actionName}`;
}

export interface GrantOptions {
  /** The subject (who is being granted access) */
  subject: Reference<any>;
  /** The resource (what they're getting access to). Omit for type-level access. */
  resource?: Reference<any>;
  /** A stable name for this action (e.g., 'edit', 'delete'). Required for storage. */
  action: string;
}

export interface CheckOptions {
  /** The subject whose access to check */
  subject: Reference<any>;
  /** The resource to check access for. Omit to check type-level access. */
  resource?: Reference<any>;
  /** The action name as passed to grant() */
  action: string;
}

export class PermissionService extends defineService({
  inject: { grants: ModelRepository.of(PermissionGrant) },
  factory: ({ grants }) => ({
    /**
     * Grant a principal explicit access for an action.
     *
     * @param permission - The permission definition (e.g. `Product.can.edit`)
     * @param options - Grant options (subject, optional resource, action name)
     */
    async grant(permission: SinglePermissionDef, options: GrantOptions): Promise<void> {
      const key = actionKey(permission, options.action);
      const subjectType = permission.subjectClass.name;
      const subjectId = options.subject.identifier;
      const resourceType = options.resource ? (options.resource as any).constructor?.name ?? 'unknown' : undefined;
      const resourceId = options.resource?.identifier;

      // Check if already granted - avoid duplicates
      const existing = await grants.findOne(
        q.and(
          PermissionGrant.fields.action.eq(key),
          PermissionGrant.fields.subjectType.eq(subjectType),
          PermissionGrant.fields.subjectId.eq(subjectId),
          ...(resourceId
            ? [PermissionGrant.fields.resourceId.eq(resourceId)]
            : [PermissionGrant.fields.resourceId.isNull()]),
        ),
      );

      if (existing) {
        if (!existing.granted) {
          using locked = await grants.lock(existing);
          if (locked) await grants.update(locked, { granted: true });
        }
        return;
      }

      await grants.insert({
        action: key,
        subjectType,
        subjectId,
        resourceType,
        resourceId,
        granted: true,
      });
    },

    /**
     * Revoke a principal's explicit access for an action.
     *
     * @param permission - The permission definition
     * @param options - Options matching the original grant
     */
    async revoke(permission: SinglePermissionDef, options: GrantOptions): Promise<void> {
      const key = actionKey(permission, options.action);
      const subjectType = permission.subjectClass.name;
      const subjectId = options.subject.identifier;
      const resourceId = options.resource?.identifier;

      await grants.deleteWhere(
        q.and(
          PermissionGrant.fields.action.eq(key),
          PermissionGrant.fields.subjectType.eq(subjectType),
          PermissionGrant.fields.subjectId.eq(subjectId),
          ...(resourceId
            ? [PermissionGrant.fields.resourceId.eq(resourceId)]
            : [PermissionGrant.fields.resourceId.isNull()]),
        ),
      );
    },

    /**
     * Check if a principal has an explicit grant for an action.
     *
     * @returns true if the principal has been explicitly granted access
     */
    async check(permission: SinglePermissionDef, options: CheckOptions): Promise<boolean> {
      const key = actionKey(permission, options.action);
      const subjectType = permission.subjectClass.name;
      const subjectId = options.subject.identifier;
      const resourceId = options.resource?.identifier;

      // Symmetric check: a resource-scoped check requires an exact resourceId
      // match. A type-level grant (resourceId IS NULL) does NOT satisfy a
      // resource-level check - the caller must explicitly omit `resource` to
      // query type-level access. This prevents type-level grants from silently
      // granting access to every specific resource.
      const grant = await grants.findOne(
        q.and(
          PermissionGrant.fields.action.eq(key),
          PermissionGrant.fields.subjectType.eq(subjectType),
          PermissionGrant.fields.subjectId.eq(subjectId),
          PermissionGrant.fields.granted.isTrue(),
          ...(resourceId
            ? [PermissionGrant.fields.resourceId.eq(resourceId)]
            : [PermissionGrant.fields.resourceId.isNull()]),
        ),
      );

      return grant !== undefined && grant.granted;
    },
  }),
}) {}
