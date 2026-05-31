import { createPgModel, createPgRepository } from '@justscale/postgres';
import { RewardTier } from '../../domain/reward-tier.js';

export const PgRewardTier = createPgModel(RewardTier, {
  table: 'reward_tiers',
  relations: {
    campaign: { onDelete: 'CASCADE' },
  },
  indexes: [
    { fields: ['campaignId'], name: 'idx_reward_tiers_campaign' },
  ],
});

export const RewardTierRepository = createPgRepository(PgRewardTier);
