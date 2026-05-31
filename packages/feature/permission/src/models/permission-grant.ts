/**
 * PermissionGrant model - stores explicit permission grants.
 *
 * Used by `permissions.grant()` / `permissions.revoke()` for permissions
 * that require explicit DB-backed grants rather than field-based rules.
 */

import { defineModel, field } from '@justscale/core/models';

export class PermissionGrant extends defineModel({
  name: 'JustScale_PermissionGrant',
  fields: {
    /** Model name of the subject (e.g., 'Seller', 'Customer') */
    subjectType: field.string(),
    /** Identifier of the subject */
    subjectId: field.string(),
    /** Action string (e.g., 'Product:create', 'Product:edit') */
    action: field.string(),
    /** Model name of the resource (null = all resources of this type) */
    resourceType: field.string().optional(),
    /** Identifier of the resource (null = all resources of this type) */
    resourceId: field.string().optional(),
    /** Whether this grant is active */
    granted: field.boolean().default(true),
  },
}) {}
