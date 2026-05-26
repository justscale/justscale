# @justscale/datastar

[Datastar](https://data-star.dev/) integration for JustScale. Adds a `Watch` route factory for long-lived reactive subscriptions that stream HTML/signal updates to the browser over SSE — no client-side framework required on the receiving side.

## Install

```bash
pnpm add @justscale/datastar
```

Side-effect import at app boot registers the factory with `@justscale/core/plugin`:

```ts
import '@justscale/datastar';
```

## Usage

```ts
import { createController } from '@justscale/core';
import { html } from '@justscale/datastar';

createController({
  inject: { items: ItemService },
  routes: ({ items }) => ({
    list: Get('/items').handle(({ res }) => res.json(items.all())),

    updates: Watch('/items/updates').handle(async function* ({ stream, aborted }) {
      // Release upstream resources when the client disconnects.
      aborted.then(() => items.unsubscribe());

      for await (const item of items.subscribe()) {
        // HTML fragments go through stream.mergeFragments(...).
        stream.mergeFragments(
          html`<li id="item-${item.id}">${item.name}</li>`,
          { selector: '#items', mergeMode: 'append' },
        );
        // A yielded object is sent as a signal patch (datastar-merge-signals).
        yield { itemCount: items.count() };
      }
    }),
  }),
});
```

Inside a `Watch` generator you stream to the client two ways: call
`stream.mergeFragments(html, opts)` for DOM fragments, and `yield` a plain
object for signal patches. (A bare `yield html\`…\`` does **not** inject a
fragment — it is serialised as a signal.) The connection is long-lived;
`ctx.aborted` resolves when the client disconnects, so use it to close whatever
the generator reads from — that ends the `for await` and runs your `finally`.

## Primitives

- `Watch` — the route factory.
- `html` / `rawHtml` — tagged-template helpers for building fragments with correct escaping (`html`) or opting out (`rawHtml`).
- `createSignalRepository` / `SignalRepository` — server-side signal store that pairs with the Datastar client.

## Docs

https://justscale.sh/features/datastar
