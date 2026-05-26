/**
 * `@justscale/hmr` — dev-only hot-module-replacement orchestration.
 *
 * This package glues together three things that each live in their
 * proper home:
 *
 *   - `@justscale/core/hmr` runtime primitives (`setHmrContainer`,
 *     `Container.hotReload()`, lifecycle `hotReload` hooks).
 *   - `@justscale/typescript`'s pure library fns (`detectChanges`,
 *     `createHmrTransformer`).
 *   - A file watcher + a Node loader hook that actually drives the
 *     reload cycle.
 *
 * Nothing here should be loaded in production — the package is a
 * `devDependency` of user apps and its entry points are invoked only
 * from `just dev`. The kernel dynamic-imports it when
 * `NODE_ENV === 'development'`.
 */

export { startHmrWatcher } from './watcher.js';
export type { HmrWatcherOptions, HmrWatcherHandle } from './watcher.js';
