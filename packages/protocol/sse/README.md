# @justscale/sse

Server-Sent Events for JustScale. Register an `SSE` route that yields events to an HTTP client as an async generator.

## Install

```bash
pnpm add @justscale/sse
```

## Usage

```ts
import { SSE } from '@justscale/sse';
import { createController, EventBus } from '@justscale/core';

createController({
  inject: { bus: EventBus },
  routes: ({ bus }) => ({
    events: SSE('/events')
      .handle(async function* () {
        for await (const event of bus.subscribe('*')) {
          yield { event: event.type, data: event.payload };
        }
      }),
  }),
});
```

The handler is a generator — `yield { event, data }` sends an SSE frame, returning ends the stream, throwing sends an `error` event and closes. Heartbeats are emitted automatically. `SSE` routes are registered through `@justscale/http`'s request-handler chain, so they sit on the same port as the rest of the HTTP surface.

## Docs

https://justscale.sh/features/datastar (Datastar rides on top of SSE for reactive streaming.)
