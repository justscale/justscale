import { defineModel, field } from '@justscale/core/models';
import { permit } from '@justscale/permission';
import { User } from '@justscale/auth';
import { ChatRoom } from './chat-room.model.js';

export type MembershipRole = 'owner' | 'moderator' | 'member';

export class Membership extends defineModel({
  fields: {
    room:        field.ref(() => ChatRoom),
    user:        field.ref(() => User),
    role:        field.enum('MembershipRole', ['owner', 'moderator', 'member']).default('member'),
    joinedAt:    field.timestamp(),
    mutedUntil:  field.timestamp().optional(),
    bannedUntil: field.timestamp().optional(),
  },
  permissions: ({ user }) => ({
    leave: permit(User).when(user),
  }),
}) {}
