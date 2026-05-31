import { defineModel, field } from '@justscale/core/models';
import { permit, Everyone } from '@justscale/permission';
import { Creator } from './creator.js';

export class Campaign extends defineModel({
  fields: {
    creator: field.ref(Creator),
    title: field.string().max(255),
    description: field.text(),
    goalAmount: field.decimal(12, 2),
    currentAmount: field.decimal(12, 2).default('0.00'),
    status: field.enum('CampaignStatus', [
      'draft', 'active', 'funded', 'failed', 'settling', 'completed',
    ] as const).default('draft'),
    deadline: field.timestamp().optional(),
    durationDays: field.int().default(30),
    imageUrls: field.array(field.string()).optional(),
    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
  permissions: ({ creator }) => ({
    edit: permit(Creator).when(creator),
    publish: permit(Creator).when(creator),
    cancel: permit(Creator).when(creator),
    // View permissions (declaration order matters — owner check first):
    viewAsOwner: permit(Creator).when(creator),
    view: permit(Everyone).always(),
  }),
}) {}
