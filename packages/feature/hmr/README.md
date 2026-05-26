# @justscale/hmr

Dev-only hot module reload for JustScale. File watcher plus a Node loader hook that, when a source file changes, re-imports it and swaps the updated service factories into the running DI container — no process restart, no reconnecting clients, live WebSocket sessions intact.

Dev dependency only. The kernel dynamic-imports this package when `NODE_ENV === 'development'`, so it never ends up in a production bundle. `just dev` pulls it in automatically; production servers boot without it.

## Install

```bash
pnpm add -D @justscale/hmr
```

Peers: `@justscale/core`, `@justscale/typescript`.

## Usage

You typically don't call this package directly — `just dev` wires it. If you're booting by hand:

```bash
node \
  --import @justscale/typescript/register \
  --import tsx \
  --import @justscale/hmr/register \
  src/main.ts
```

`@justscale/hmr/register` installs a Node loader observer that records every `file:` URL the app loads, then subscribes to the kernel's `onContainerReady` hook. Once the container is ready, the watcher spins up against the directories the app actually loaded from — not the whole repo.

## What gets reloaded

For every file that changes:

1. The loader bumps the version of the file and every ancestor that transitively imported it (cache-busts via `?v=N` in the resolved URL).
2. The module is re-imported through the same loader chain, so source maps and the JustScale TypeScript compilation survive.
3. For every exported service / controller in the new module that was registered on the container at boot, the old class object is mutated so `.factory` and `.deps` point at the new versions. Existing references keep pointing at the same token.
4. `container.replaceInstance(token, newFactory)` is called — object-returning factories get `delete` + `Object.assign` onto the live instance; function-returning factories swap the indirection proxy's inner pointer.

Net effect: handlers that closed over the instance see new behaviour on their next call. HTTP / Ws / SSE connections stay open.

## Sub-apps

Sub-apps keep their own container. The watcher walks `app.subApps` recursively so a file change inside a sub-app swaps the factory on the right container rather than silently missing.

## Models

`defineModel` stamps a stable ID on the class, so `ModelRepository.of(...)` auto-updates the internal class ref on re-import. No model-specific HMR bookkeeping — model changes flow through the DI binding graph like any other dependency.

## What isn't reloaded

- Anything held by reference on a long-lived object that isn't a service or controller factory. If you stash a config blob in a plain module variable, it won't update until the holder reloads.
- Environment / config schema changes. A new `defineConfigPartial` or new required config key needs a restart.
- Native modules, native loaders, and the Node runtime itself.

HMR is best-effort: a watcher that doesn't catch a change is always recoverable with `Ctrl-C` + `just dev`.

## Public API

```ts
import { startHmrWatcher, type HmrWatcherOptions, type HmrWatcherHandle } from '@justscale/hmr';

const handle = await startHmrWatcher({
  container,         // Container — which scope to replace services on
  root,              // string  — project root, used for stable IDs
  debounceMs: 150,   // number  — per-file debounce window (default 150)
  logger,            // Logger? — override; defaults to container.createLogger('hmr')
});

await handle.stop();
```

`@justscale/hmr/register` is the subpath users add to their `--import` chain. Everything else is internal.

## Docs

https://justscale.sh/cli/dev
