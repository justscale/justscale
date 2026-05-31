import { createPgModel, createPgRepository } from '@justscale/postgres';
import { Membership } from '../../domains/chat/membership.model.js';

export const PgMembership = createPgModel(Membership, { table: 'memberships' });
export const PgMembershipRepository = createPgRepository(PgMembership);
