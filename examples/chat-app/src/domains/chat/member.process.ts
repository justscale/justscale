import { createProcess, delay, race, signal, stream } from '@justscale/core/process';
import { ModelRepository } from '@justscale/core/models';
import { User } from '@justscale/auth';
import { ChatRoom } from './chat-room.model.js';
import { ChatSignals } from './chat.signals.js';

interface FeedEvent {
  type: string;
  data: unknown;
}

/**
 * Per-member subprocess.
 *
 * Spawned by the WS controller on first connect. Merges two sources into
 * one personalized feed that the socket drains:
 *   - `room.broadcast` — the public event stream (messages, topic changes,
 *     member joins/leaves) — every instance sees this via Postgres LISTEN/NOTIFY
 *   - private signals targeting this specific `(room, user)` — kicks, bans,
 *     DMs, post-rejections
 *
 * Idle 1h → terminate. WS handler will respawn on the next connect.
 *
 * TODO(v2): when `banned` arrives with a non-zero `durationSeconds`,
 * spawn a one-shot `banTimer` subprocess that races `delay.seconds(...)`
 * against a cancel signal, and emits `memberUnbanned` when the timer
 * wins. v1 keeps ban lifting manual (POST /unban).
 */
export const chatMember = createProcess({
  path: '/chatroom/:room/member/:user',
  types: { room: ChatRoom, user: User },
  inject: { rooms: ModelRepository.of(ChatRoom), signals: ChatSignals },

  async handler({ rooms, signals }, { room, user }) {
    void user; // path param, scopes process identity; not referenced in handler body
    using found = await rooms.get(room);
    if (!found) return { error: 'Room not found' };

    using exports = { events: [] as FeedEvent[] };

    // NOTE: pushing inline instead of via a `push` closure. The compiler
    // promotes local closures to `state.vars`, but functions can't be
    // serialized — on resume they come back as null and calling them
    // throws. Keep appends inline until the compiler's closure-recreate
    // story lands.
    exports.events.push({ type: 'connected', data: {} });

    while (true) {
      const r = race();
      switch (true) {
        case stream(r, found.broadcast):
          exports.events.push({ type: r.value.type as string, data: r.value.data });
          break;

        case signal(r, signals.kicked):
          exports.events.push({ type: 'you_were_kicked', data: { by: r.by, reason: r.reason } });
          return { reason: 'kicked' };

        case signal(r, signals.banned):
          exports.events.push({ type: 'you_were_banned', data: { by: r.by, until: r.until } });
          break;

        case signal(r, signals.unbanned):
          exports.events.push({ type: 'you_were_unbanned', data: {} });
          break;

        case signal(r, signals.dm):
          exports.events.push({ type: 'dm', data: { from: r.from, text: r.text } });
          break;

        case signal(r, signals.postRejected):
          exports.events.push({ type: 'post_rejected', data: { reason: r.reason } });
          break;

        case delay.hours(r, 1):
          return { reason: 'idle_timeout' };
      }
    }
  },
});
