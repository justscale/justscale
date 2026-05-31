import { defineModel, field } from '@justscale/core/models';
import { permit } from '@justscale/permission';
import { Campaign } from './campaign.js';
import { Backer } from './backer.js';
import { RewardTier } from './reward-tier.js';

export class Pledge extends defineModel({
  fields: {
    campaign: field.ref(Campaign),
    backer: field.ref(Backer),
    rewardTier: field.ref(RewardTier).optional(),
    amount: field.decimal(10, 2),
    status: field.enum('PledgeStatus', [
      'pending', 'charged', 'refunded', 'failed',
    ] as const).default('pending'),
    chargedAt: field.timestamp().optional(),
    refundedAt: field.timestamp().optional(),
    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
  permissions: ({ backer }) => ({
    view: permit(Backer).when(backer),
    cancel: permit(Backer).when(backer),
  }),
}) {}
