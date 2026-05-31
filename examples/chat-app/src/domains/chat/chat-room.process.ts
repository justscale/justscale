import { createProcess, delay, race, signal } from '@justscale/core/process';
import { ModelRepository, q } from '@justscale/core/models';
import { User } from '@justscale/auth';
import { ChatRoom } from './chat-room.model.js';
import { Membership } from './membership.model.js';
import { Message } from './message.model.js';
import { ChatSignals } from './chat.signals.js';

/**
 * Room process.
 *
 * One instance per room across the whole cluster (advisory lock on the
 * process path). Commands from any app instance land here as signals;
 * every broadcast goes out to all app instances via Postgres
 * LISTEN/NOTIFY on the broadcast stream. 16 pods or 1 — same code path.
 *
 * Membership state is kept strictly in the durable `Membership` table —
 * no in-process hydrated cache. Every signal that needs role/ban/mute
 * context queries the DB by (room, user). That keeps the handler body
 * flat and side-steps a compiler issue with for-of'ing over awaited
 * ref-bearing rows at handler entry.
 *
 * No Date.now() anywhere — the process runtime rejects it (replay
 * safety). The 4h idle timer is `delay.hours(r, 4)` in the race, which
 * naturally resets on every signal.
 */
export const chatRoom = createProcess({
  path: '/chatroom/:room',
  types: { room: ChatRoom },
  inject: {
    rooms:       ModelRepository.of(ChatRoom),
    memberships: ModelRepository.of(Membership),
    messages:    ModelRepository.of(Message),
    signals:     ChatSignals,
  },

  async handler({ rooms, memberships, messages, signals }, { room }) {
    using found = await room;
    if (!found) return { error: 'Room not found' };
    const roomId = ChatRoom.ref(found).identifier;

    while (true) {
      const r = race();
      switch (true) {
        case signal(r, signals.messagePosted): {
          const m = await memberships.findOne(
            q.and(
              Membership.fields.room.eq(found),
              Membership.fields.user.eq(User.ref`${r.author}`),
            ),
          );
          if (!m || m.bannedUntil !== undefined || m.mutedUntil !== undefined) {
            await signals.postRejected({
              room: roomId,
              user: r.author,
              reason: !m ? 'not_a_member' : m.bannedUntil ? 'banned' : 'muted',
            });
            break;
          }
          await messages.insert({
            room: found,
            author: User.ref`${r.author}`,
            text: r.text,
            postedAt: new Date(r.at),
          });
          found.broadcast.publish({
            type: 'message',
            data: { author: r.author, text: r.text, at: r.at },
          });
          break;
        }

        case signal(r, signals.memberJoined):
          found.broadcast.publish({ type: 'member_joined', data: { user: r.user, role: r.role } });
          break;

        case signal(r, signals.memberLeaving):
          found.broadcast.publish({ type: 'member_left', data: { user: r.user } });
          break;

        case signal(r, signals.topicChanged): {
          using locked = await rooms.lock(found);
          if (!locked) break;
          await rooms.update(locked, { topic: r.topic });
          found.broadcast.publish({ type: 'topic_changed', data: { topic: r.topic, by: r.by } });
          break;
        }

        case signal(r, signals.memberKicked):
          await signals.kicked({ room: roomId, user: r.user, by: r.by, reason: r.reason });
          found.broadcast.publish({ type: 'member_kicked', data: { user: r.user, by: r.by } });
          break;

        case signal(r, signals.memberBanned):
          await signals.banned({ room: roomId, user: r.user, by: r.by, until: r.until });
          found.broadcast.publish({ type: 'member_banned', data: { user: r.user, until: r.until } });
          break;

        case signal(r, signals.memberUnbanned):
          await signals.unbanned({ room: roomId, user: r.user });
          found.broadcast.publish({ type: 'member_unbanned', data: { user: r.user } });
          break;

        case signal(r, signals.roomClosed):
          found.broadcast.publish({ type: 'room_closed', data: { reason: 'closed_by_owner' } });
          return { reason: 'closed' };

        case delay.hours(r, 4):
          found.broadcast.publish({ type: 'room_closed', data: { reason: 'inactivity' } });
          return { reason: 'inactivity' };
      }
    }
  },
});
