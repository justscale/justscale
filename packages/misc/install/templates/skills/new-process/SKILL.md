---
name: new-process
description: Scaffold a new JustScale durable process — generates `<name>.signals.ts` and `<name>.process.ts` matching this repo's idiom. Forces `.types({...})` on every signal path param, `Locked<T>` mutators, no string IDs, imports only from `@justscale/core/process` and `@justscale/core/models`. Trigger when the user asks to create a process, durable workflow, saga, or signal-driven flow.
---

# Skill: new-process

Scaffold a new durable process. Match the simple-app idiom — every signal
path param `.types()`d, every mutator `Locked<T>`, no string IDs leaking
through.

## Usage

`/new-process <name> [Model]`

Example: `/new-process orderFulfillment Order`

If the user didn't specify a Model or a domain folder, ask once.
Placing files in the wrong domain folder is harder to fix than asking.

## What to generate

Two files in the same domain folder as the related Model:

1. `<name>.signals.ts` — `defineSignals(...)`
2. `<name>.process.ts` — `createProcess(...)`

## Rules — non-negotiable

The framework enforces these at compile time. Writing the file correctly
the first time is faster than chasing type errors.

1. **Every signal path parameter MUST be `.types({...})`d.** The path is
   the topic on the cluster bus; typed params are the routing key. Two
   forms are valid:
   - Explicit: `.types({ cart: Cart })` — for path `/cart/:cart/...`
   - Lowercased shorthand: `.types({ Cart })` — also for `:cart`
   Prefer the explicit form. It's what `examples/simple-app/` uses and
   it's unambiguous when param names don't match model names.
2. **Service mutators take `Locked<T>`** — never `Ref<T>` or string ID.
   If a method changes state, its signature must declare the lock.
3. **Path parameter names match the model token in `.types({...})`.** A
   mismatch is a compile error.
4. **`signal.data<T>` is for non-routable payload only.** Anything that
   identifies an entity goes in the path with `.types`, never in `.data`.
5. **No string IDs in the process file.** If a `Locked<T>` isn't already
   in scope from the signal payload, the handler `await`s the `Ref` to
   materialise a `Persistent`.
6. **Imports come from `@justscale/core/process` and
   `@justscale/core/models` only.** Never reach into infra packages
   (`@justscale/postgres`, `@justscale/redis`) from a process file.

## Template

`<name>.signals.ts`:

```typescript
import { defineSignals } from '@justscale/core/process';
import { <Model> } from './<model>.model.js';

export class <Name>Signals extends defineSignals((signal) => ({
  <eventName>: signal('/<root>/:<param>/<verb>')
    .data<{ /* optional non-routable payload */ }>()
    .types({ <param>: <Model> }),
})) {}
```

`<name>.process.ts`:

```typescript
import { createProcess, signal, race, delay } from '@justscale/core/process';
import { <Model> } from './<model>.model.js';
import { <Name>Signals } from './<name>.signals.js';

export const <name> = createProcess({
  path: '/<root>/:<param>/<verb>',
  types: { <param>: <Model> },
  inject: { signals: <Name>Signals },

  async handler({ signals }, { <param> }) {
    const r = race();
    switch (true) {
      case signal(r, signals.<eventName>):
        // r.<param> is Locked<<Model>> — the signal carried the locked entity.
        return { status: 'done' as const };
      case delay.days(r, 3):
        return { status: 'timeout' as const };
    }
  },
});
```

## Reference

The canonical examples are:

- `examples/simple-app/src/domains/cart/cart.signals.ts` — explicit
  `.types({ cart: Cart })` form, `.data<{...}>()` payloads.
- `examples/simple-app/src/domains/cart/cart-lifecycle.process.ts` —
  `while (true) { race + signal/delay switch }` shape.

When in doubt, copy the structure of those files.

## After generating

- Print both file paths.
- Remind the user to register the signal class and the process in the
  domain's `.feature.ts` (or `app.ts` for tiny projects):
  - `.add(<Name>Signals)`
  - `.add(<name>)`
- Do NOT modify `app.ts` or `*.feature.ts` automatically. Bootstrap
  edits cause merge churn — let the user wire it.

## When NOT to use this skill

- Plain async helpers that don't need to suspend → write a
  `defineService`, not a process.
- One-shot HTTP handlers → use a controller route.
- Cron-style schedules → use the scheduled-task primitive.
