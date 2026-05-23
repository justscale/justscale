import { defineModel, field } from '@justscale/core/models';
import { User } from './user.js';

export class Session extends defineModel({
  name: 'JustScale_Session',
  fields: {
    user: field.ref(User),
    token: field.string().max(255),
    userAgent: field.string().max(500).optional(),
    ipAddress: field.string().max(45).optional(),
    expiresAt: field.timestamp(),
    lastActiveAt: field.timestamp(),
  },
}) {}
