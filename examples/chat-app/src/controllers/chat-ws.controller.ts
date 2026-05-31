import { createController } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { Ws } from '@justscale/websocket';
import { SessionService, User } from '@justscale/auth';
import { ChatRoom } from '../domains/chat/chat-room.model.js';
import {
  ChatService,
  BannedError,
  MutedError,
  NotAMemberError,
  NotAuthorizedError,
} from '../domains/chat/chat.service.js';
import { chatMember } from '../domains/chat/member.process.js';
import { ClientMessage } from './schemas/chat.js';

/**
 * Authenticated member socket.
 *
 * WS has no cookie/header/body story like HTTP — the auth middleware
 * can't compose with WS context. So auth lives inline: the client
 * connects with `?token=<session-token>` and we resolve a session out
 * of that. Simple and demo-appropriate; a production replacement
 * would use a proper subprotocol or a CONNECT handshake.
 *
 * On open:
 *   1. Validate session → resolve User
 *   2. Ensure the room process is running
 *   3. Spawn the per-member subprocess (or attach to the existing one)
 *   4. Outbound pump: drain the subprocess's exports into the socket
 *      (public broadcast + private signals merged into one feed)
 *   5. Inbound: translate client commands into ChatService calls
 */
export const ChatWsController = createController({
  inject: {
    chat:     ChatService,
    sessions: SessionService,
    users:    ModelRepository.of(User),
  },

  routes: ({ chat, sessions, users }) => ({
    room: Ws('/rooms/:room/ws')
      .types({ room: ChatRoom })
      .message(ClientMessage)
      .handle(async ({ messages, send, params, query, close }) => {
        const token = query.token;
        if (!token) { close(4001, 'Missing token'); return; }
        const session = await sessions.findByToken(token);
        if (!session) { close(4001, 'Invalid or expired session'); return; }
        const user = await users.get(session.user);
        if (!user) { close(4001, 'User not found'); return; }

        const room = await params.room;
        if (!room) { close(4004, 'Room not found'); return; }

        await chat.ensureProcess(room);
        const handle = await chatMember([
          ChatRoom.ref(room).identifier,
          User.ref(user).identifier,
        ]);

        // Outbound: drain the member subprocess's exports.
        // Each snapshot's `events` array grows append-only; track how
        // many we've already forwarded so we don't double-send.
        let sent = 0;
        const pump = (async () => {
          for await (const snap of handle.data as AsyncIterable<{ events?: { type: string; data: unknown }[] }>) {
            const events = snap?.events ?? [];
            for (; sent < events.length; sent++) {
              send({ type: events[sent].type, data: events[sent].data });
            }
          }
        })();

        // Inbound: every client command translates to a service call.
        // Service errors for membership/ban/mute don't close the socket —
        // we send `post_rejected` and the client keeps going.
        try {
          for await (const msg of messages) {
            try {
              switch (msg.type) {
                case 'post':
                  await chat.post(room, user, msg.text);
                  break;
                case 'dm':
                  await chat.sendDm(room, user, User.ref`${msg.to}`, msg.text);
                  break;
              }
            } catch (err) {
              if (err instanceof NotAMemberError
                  || err instanceof BannedError
                  || err instanceof MutedError
                  || err instanceof NotAuthorizedError) {
                send({ type: 'post_rejected', data: { reason: err.message } });
                continue;
              }
              throw err;
            }
          }
        } finally {
          await pump.catch(() => {});
        }
      }),
  }),
});
