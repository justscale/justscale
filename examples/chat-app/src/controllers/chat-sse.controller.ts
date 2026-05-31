import { createController } from '@justscale/core';
import { SSE } from '@justscale/sse';
import { ChatRoom } from '../domains/chat/chat-room.model.js';
import { ChatService } from '../domains/chat/chat.service.js';

/**
 * Public read-only spectating via SSE.
 *
 * Anyone can attach — no auth, no membership required. Perfect for a
 * curl-based multi-instance demo: point `curl -N` at any app instance
 * and every room event reaches it via Postgres LISTEN/NOTIFY.
 *
 * Authenticated members go through the WS controller instead — one
 * bidirectional socket per member, with private signals (DMs,
 * kick/ban notifications) layered on top of the public stream.
 */
export const ChatSseController = createController({
  inject: { chat: ChatService },

  routes: ({ chat }) => ({
    spectate: SSE('/rooms/:room/spectate')
      .types({ room: ChatRoom })
      .handle(async function* ({ params }) {
        const room = await params.room;
        if (!room) {
          yield { event: 'error', data: { message: 'Room not found' } };
          return;
        }

        await chat.ensureProcess(room);
        yield { event: 'connected', data: { name: room.name, topic: room.topic ?? null } };

        for await (const msg of room.broadcast) {
          yield { event: msg.type as string, data: msg.data };
        }
      }),
  }),
});
