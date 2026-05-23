/**
 * Shared CLI assembly: glue together the user's `app` builder, the
 * built-in `WorkspaceController`, and CLI controllers contributed by
 * installed packages. Used by both the `just` binary and the `mcp serve`
 * command so they dispatch against the exact same DI graph.
 */

import { createAppInternal, type App } from '../app.js';
import { loadEnvironment } from '../features/environment/load.js';
import { WorkspaceController } from './workspace-controller.js';
import { discover, discoverPackageCommands } from './discovery.js';
import { pickAppLoader } from './define-project.js';

/**
 * Return a ready-to-run CLI `App`:
 *
 * - If `justscale.config.ts` declares `app`, resolve the active env (via
 *   `loadEnvironment` anchored at the config file), pick the loader for
 *   `env.type`, import the module, coerce the default export to a
 *   JustScale builder, register `WorkspaceController` plus any
 *   package-contributed CLI controllers, and `.build()`.
 *
 * - Otherwise, run just the built-in `WorkspaceController`.
 */
export async function assembleCliApp(): Promise<App<any>> {
  const result = await discover();

  if (!result || !result.config.app) {
    const app = createAppInternal({ controllers: [WorkspaceController] });
    await app.ready;
    return app;
  }

  // Load env first - its `type` drives which app module to load. The
  // config file URL anchors `env/` resolution to the project root (not
  // the workspace cwd that `just` may have been invoked from).
  const env = await loadEnvironment({ from: { url: result.configFileUrl } });
  const loader = pickAppLoader(result.config.app, env.type);
  const appModule = await loader();
  const exported = (appModule as { default?: unknown }).default ?? appModule;

  // `exported` is typically a DefinedApp callable: `(env?) => Promise<builder>`.
  // Passing the pre-loaded env skips its internal `loadEnvironment` call so
  // we don't double-load. Non-callable exports (rare) pass through.
  const builderLike =
    typeof exported === 'function'
      ? await (exported as (e?: unknown) => unknown)(env)
      : exported;

  if (!builderLike || typeof (builderLike as { addControllers?: unknown }).addControllers !== 'function') {
    throw new Error(
      '`app` must resolve to a JustScale builder (before `.build()`). ' +
      'Export a factory that returns the builder, e.g.:\n\n' +
      '  export default defineApp(import.meta, (env) => JustScale().add(env)...)\n',
    );
  }

  const packageControllers = await discoverPackageCommands();
  const builtApp = (builderLike as { addControllers: (cs: unknown[]) => { build: () => { app: App<any> } } })
    .addControllers([WorkspaceController, ...packageControllers])
    .build();
  await builtApp.app.ready;
  return builtApp.app;
}
