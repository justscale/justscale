import { createPgModel, createPgRepository } from '@justscale/postgres';
import { Campaign } from '../../domain/campaign.js';

export const PgCampaign = createPgModel(Campaign, {
  table: 'campaigns',
  overrides: {
    status: { index: true },
  },
  relations: {
    creator: { onDelete: 'RESTRICT' },
  },
  indexes: [
    { fields: ['status', 'deadline'], name: 'idx_campaigns_status_deadline' },
  ],
});

export const CampaignRepository = createPgRepository(PgCampaign);
