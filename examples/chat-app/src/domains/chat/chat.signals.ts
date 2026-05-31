import { defineSignals } from '@justscale/core/process';
import type { MembershipRole } from './membership.model.js';

/**
 * Signal catalogue.
 *
 * Path params are string identifiers — emitters pass `Ref<T>.identifier`,
 * processes convert back with `Model.ref` when they need the entity.
 * `.types({...})` stays on the *process* definitions (where the handler
 * genuinely wants `Locked<T>`); declaring it here would force every
 * emitter to hold a lock first, which is wasteful for fire-and-forget
 * flows like post.
 *
 * Two address spaces:
 *   - Room-scope signals target the room process (`/chatroom/:room/...`)
 *   - Member-scope signals target a specific member subprocess
 *     (`/chatroom/:room/member/:user/...`) — private per-user events
 *     (kicks, bans, DMs, post-rejections).
 */
export class ChatSignals extends defineSignals(signal => ({
  // Room-scope — room process wakes on these
  messagePosted:  signal('/chatroom/:room/messagePosted').data<{ author: string; text: string; at: string }>(),
  memberJoined:   signal('/chatroom/:room/memberJoined').data<{ user: string; role: MembershipRole }>(),
  memberLeaving:  signal('/chatroom/:room/memberLeaving').data<{ user: string }>(),
  topicChanged:   signal('/chatroom/:room/topicChanged').data<{ topic: string; by: string }>(),
  memberKicked:   signal('/chatroom/:room/memberKicked').data<{ user: string; by: string; reason?: string }>(),
  memberBanned:   signal('/chatroom/:room/memberBanned').data<{ user: string; by: string; until: string }>(),
  memberUnbanned: signal('/chatroom/:room/memberUnbanned').data<{ user: string }>(),
  roomClosed:     signal('/chatroom/:room/closed'),

  // Member-scope — member subprocess wakes on these
  kicked:       signal('/chatroom/:room/member/:user/kicked').data<{ by: string; reason?: string }>(),
  banned:       signal('/chatroom/:room/member/:user/banned').data<{ by: string; until: string }>(),
  unbanned:     signal('/chatroom/:room/member/:user/unbanned'),
  dm:           signal('/chatroom/:room/member/:user/dm').data<{ from: string; text: string }>(),
  postRejected: signal('/chatroom/:room/member/:user/postRejected').data<{ reason: string }>(),
})) {}
