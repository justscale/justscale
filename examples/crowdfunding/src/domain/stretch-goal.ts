import { defineModel, field } from '@justscale/core/models';
import { Campaign } from './campaign.js';

export class StretchGoal extends defineModel({
  fields: {
    campaign: field.ref(Campaign),
    title: field.string().max(255),
    description: field.text(),
    targetAmount: field.decimal(12, 2),
    unlockedAt: field.timestamp().optional(),
    createdAt: field.createdAt(),
  },
}) {}
