/**
 * @justscale/permission
 *
 * Model-level permission declarations with typed guards.
 *
 * @example
 * ```typescript
 * import { permit, AbstractPrincipalProvider, PermissionFeature } from '@justscale/permission'
 *
 * class Product extends defineModel({ fields: {...} }) {
 *   static can = {
 *     edit: permit(Seller).when(() => Product.fields.seller),
 *     view: permit(AppUser).always(),
 *     delete: [
 *       permit(Seller).when(() => Product.fields.seller),
 *       permit(Admin).always(),
 *     ],
 *   }
 * }
 *
 * // In controller:
 * Get('/:productRef')
 *   .types({ Product })
 *   .guard(Product.can.view)
 *   .handle(async ({ params }) => {
 *     const product = await params.productRef; // Reference<Product>
 *   })
 * ```
 */

export { permit, PermitBuilder } from './permit.js';
export { Everyone } from './everyone.js';
export type { FieldAccessor, Principal, SinglePermissionDef, QueryablePermissionDef, AnyPermissionDef, PermissionMode } from './types.js';
export { PERMISSION_DEF, isPermissionDef, isQueryablePermissionDef } from './types.js';
export { AbstractPrincipalProvider } from './services/principal-provider.js';
export type { PrincipalProvider } from './services/principal-provider.js';
export { PermissionService } from './services/permission.service.js';
export { AccessService } from './services/access.service.js';
export type { GrantOptions, CheckOptions } from './services/permission.service.js';
export { byPermissions } from './by-permissions.js';
export { PermissionGrant } from './models/permission-grant.js';
export { PermissionFeature } from './feature.js';
export { permissions, assertNever } from './middleware/permissions.js';
