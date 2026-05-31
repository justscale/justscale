import { z } from '@justscale/core/models';
import type { z as zType } from 'zod';
import { User } from '@justscale/auth';
import { ChatRoom } from '../../domains/chat/chat-room.model.js';
import { Membership } from '../../domains/chat/membership.model.js';
import { Message } from '../../domains/chat/message.model.js';

// ============================================================================
// Response DTOs
// ============================================================================

export const RoomDto = z.object({
  id: z.ref(ChatRoom),
  name: z.string(),
  topic: z.string().optional(),
  visibility: z.enum(['public', 'private']),
  createdBy: z.ref(User),
});

export const MembershipDto = z.object({
  id: z.ref(Membership),
  room: z.ref(ChatRoom),
  user: z.ref(User),
  role: z.enum(['owner', 'moderator', 'member']),
  joinedAt: z.date(),
  mutedUntil: z.date().optional(),
  bannedUntil: z.date().optional(),
});

export const MessageDto = z.object({
  id: z.ref(Message),
  room: z.ref(ChatRoom),
  author: z.ref(User),
  text: z.string(),
  postedAt: z.date(),
});

export const RoomListResponse   = z.object({ rooms: z.array(RoomDto) });
export const RoomResponse       = z.object({ room: RoomDto });
export const MembershipResponse = z.object({ membership: MembershipDto });
export const HistoryResponse    = z.object({ messages: z.array(MessageDto) });
export const ErrorResponse      = z.object({ error: z.string() });
export const OkResponse         = z.object({ ok: z.literal(true) });

// ============================================================================
// Request bodies
// ============================================================================

export const CreateRoomBody  = z.object({
  name: z.string().min(1).max(64),
  visibility: z.enum(['public', 'private']).default('public'),
});
export const ChangeTopicBody = z.object({ topic: z.string().max(256) });
export const KickBody        = z.object({ reason: z.string().max(256).optional() });
export const BanBody         = z.object({ minutes: z.number().int().positive() });

/**
 * Inbound WS messages — discriminated by `type`. Invalid payloads are
 * silently dropped by the websocket middleware (`.message(schema)`).
 */
export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('post'), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('dm'),   to: z.string(), text: z.string().min(1).max(2000) }),
]);
export type ClientMessage = zType.infer<typeof ClientMessage>;
