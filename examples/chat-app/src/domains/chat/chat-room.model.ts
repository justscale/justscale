import { defineModel, field } from '@justscale/core/models';
import { permit } from '@justscale/permission';
import { User } from '@justscale/auth';

/**
 * Events the room publishes on its broadcast stream. Every subscriber
 * (member subprocesses, SSE spectators) reads these. Shape is kept open
 * via `field.json()` so new event kinds don't require migrations.
 */
export class ChatRoomBroadcast extends defineModel({
  fields: {
    type: field.string(),
    data: field.json(),
  },
}) {}

export class ChatRoom extends defineModel({
  fields: {
    name:       field.string().max(64).unique(),
    topic:      field.string().max(256).optional(),
    visibility: field.enum('RoomVisibility', ['public', 'private']).default('public'),
    createdBy:  field.ref(() => User),
    broadcast:  field.stream(ChatRoomBroadcast),
  },
  /**
   * Only the permissions that are pure field-matches live here. Anything
   * that needs a Membership lookup (post / moderate / ban) is enforced in
   * ChatService because `permit().check()` runs without DI — the service
   * throws typed errors and the controller translates to 4xx.
   */
  permissions: ({ createdBy }) => ({
    view:   permit(User).always(),
    create: permit(User).always(),
    manage: permit(User).when(createdBy),
  }),
}) {}
