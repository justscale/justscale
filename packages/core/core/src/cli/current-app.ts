/**
 * Runtime registry for the currently-running `defineApp` callable.
 *
 * `defineApp(meta, factory)` stashes its callable + the env it was
 * invoked with here, after the kernel has successfully booted the
 * app. Dev-mode packages (e.g. `@justscale/hmr`) read this to
 * re-invoke the factory on file changes — rebuilding the app in a
 * throwaway graph, diffing against the live container, and applying
 * targeted replacements.
 *
 * Only one app is tracked per process. If several `defineApp`
 * callables run (rare outside tests), the latest wins.
 */

import type { Environment } from '../features/environment/types.js';
import type { App } from '../app.js';

export interface CurrentApp {
  /** The defineApp callable — invoke with the same env to rebuild. */
  readonly callable: (env: Environment) => Promise<unknown>
  /** The env the app was last built with. */
  readonly env: Environment
  /** File-URL of the entry module (from `defineApp(meta, ...)`); dev
   * tooling re-imports this URL with a cache-bust to force re-linking
   * of the entry's static imports when upstream files have changed. */
  readonly entryUrl: string
  /**
   * The live App instance. HMR reads this to push newly-appeared
   * controllers into `app.controllers` after it has resolved them
   * against the live container, so routes added via a new `.add()` in
   * the user's factory light up without a process restart. Not set
   * until the kernel has booted successfully.
   */
  readonly app: App
}

let current: CurrentApp | null = null;

export function setCurrentApp(app: CurrentApp): void {
  current = app;
}

export function getCurrentApp(): CurrentApp | null {
  return current;
}
