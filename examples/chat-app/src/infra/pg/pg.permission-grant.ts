import { createPgModel, createPgRepository } from '@justscale/postgres';
import { PermissionGrant } from '@justscale/permission';

export const PgPermissionGrant = createPgModel(PermissionGrant, { table: 'permission_grants' });
export const PgPermissionGrantRepository = createPgRepository(PgPermissionGrant);
