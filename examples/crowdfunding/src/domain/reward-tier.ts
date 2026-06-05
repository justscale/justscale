import { defineModel, field } from '@justscale/core/models';
import { Campaign } from './campaign.js';

export class RewardTier extends defineModel({
  fields: {
    campaign: field.ref(Campaign),
    title: field.string().max(255),
    description: field.text(),
    amount: field.decimal(10, 2),
    quantityAvailable: field.int().optional(),
    quantityPledged: field.int().default(0),
    isEarlyBird: field.boolean().default(false),
    earlyBirdEndsAt: field.timestamp().optional(),
    createdAt: field.createdAt(),
  },
}) {}
