import { defineModel, field } from '@justscale/core/models';

export class Creator extends defineModel({
  fields: {
    name: field.string().max(255),
    email: field.string().max(255).unique(),
    bio: field.text().optional(),
    avatarUrl: field.string().max(500).optional(),
    verified: field.boolean().default(false),
    createdAt: field.createdAt(),
    updatedAt: field.updatedAt(),
  },
}) {}
