import { defineModel, field } from '@justscale/core/models';
import { User } from '@justscale/auth';
import { ChatRoom } from './chat-room.model.js';

/**
 * Append-only durable chat log. The room process inserts one row per
 * accepted post and then publishes the corresponding broadcast event;
 * the row and the broadcast are the same message, viewed differently:
 * history vs. real-time.
 *
 * `createdAt` is populated by the process from the signal payload
 * (deterministic — the emitter stamped the time, the process just
 * stores it). Distinct from the pg adapter's system `created_at`.
 */
export class Message extends defineModel({
  fields: {
    room:   field.ref(() => ChatRoom),
    author: field.ref(() => User),
    text:   field.string().max(2000),
    postedAt: field.timestamp(),
  },
}) {}
