import { createPgModel, createPgRepository } from '@justscale/postgres';
import { Pledge } from '../../domain/pledge.js';

export const PgPledge = createPgModel(Pledge, {
  table: 'pledges',
  overrides: {
    status: { index: true },
  },
  relations: {
    campaign: { onDelete: 'RESTRICT' },
    backer: { onDelete: 'RESTRICT' },
    rewardTier: { onDelete: 'SET NULL' },
  },
  indexes: [
    { fields: ['campaignId', 'status'], name: 'idx_pledges_campaign_status' },
    { fields: ['backerId'], name: 'idx_pledges_backer' },
  ],
});

export const PledgeRepository = createPgRepository(PgPledge);
