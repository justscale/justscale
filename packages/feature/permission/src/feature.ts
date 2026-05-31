/**
 * PermissionFeature - registers the permission system.
 *
 * Requires:
 * - AbstractPrincipalProvider (app must bind an implementation)
 *
 * Provides:
 * - PermissionService (grant/revoke/check explicit permission grants)
 *
 * @example
 * ```typescript
 * import { createClusterBuilder, bindService } from '@justscale/core/cluster'
 * import { PermissionFeature, AbstractPrincipalProvider } from '@justscale/permission'
 *
 * createClusterBuilder()
 *   .add(bindService(AbstractPrincipalProvider, AppPrincipalProvider))
 *   .add(PermissionFeature)
 *   .build()
 * ```
 */

import { createFeatureBuilder } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { AbstractPrincipalProvider } from './services/principal-provider.js';
import { PermissionGrant } from './models/permission-grant.js';
import { PermissionService } from './services/permission.service.js';

export const PermissionFeature = createFeatureBuilder()
  .name('permission')
  .requires(AbstractPrincipalProvider)
  .requires(ModelRepository.of(PermissionGrant))
  .provides((b) => b.add(PermissionService));
