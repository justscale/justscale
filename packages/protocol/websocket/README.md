# @justscale/websocket

WebSocket upgrade handlers for JustScale. Exposes a `Ws` route factory that composes through the same builder pipeline as HTTP — guards, middleware, typed messages.

## Install

```bash
pnpm add @justscale/websocket
```

## Usage

```ts
import { Ws } from '@justscale/websocket';
import { createController } from '@justscale/core';
import { z } from 'zod';

const ChatMessage = z.object({ content: z.string() });

createController({
  inject: { rooms: RoomService },
  routes: ({ rooms }) => ({
    room: Ws('/chat/:roomId')
      .use(authMiddleware)
      .message(ChatMessage)
      .handle(async ({ messages, send, params, user }) => {
        for await (const msg of messages) {
          await rooms.broadcast(params.roomId, { from: user.id, text: msg.content });
        }
      }),
  }),
});
```

Messages arrive as an `AsyncIterable<T>` — exit the `for await` loop (or let the handler return) and the socket closes cleanly. Cluster transport registers automatically when `@justscale/core/cluster` is loaded.

## Docs

https://justscale.sh/websocket/overview · https://justscale.sh/websocket/messages
