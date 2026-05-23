/**
 * @example
 * ```ts
 * import { defineApp } from '@justscale/core';
 *
 * export default defineApp(import.meta, (env) =>
 *   JustScale()
 *     .add(env)
 *     .add(PostgresFeature)
 *     .add(OrderController)
 * );
 * ```
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '../features/environment/load.js';
import type { Environment } from '../features/environment/types.js';
import type { App } from '../app.js';
import { setCurrentApp } from './current-app.js';

let autorunFired = false;

/** User factory: `(env) => builder`. May be sync or async. */
export type AppFactory<TEnv extends Environment, TBuilder> = (
  env: TEnv,
) => TBuilder | Promise<TBuilder>;

/**
 * Callable returned by `defineApp`. Called with no args, loads env automatically.
 * Pass an explicit Environment to skip loading (useful in tests).
 */
export interface DefinedApp<TEnv extends Environment, TBuilder> {
  (env?: TEnv): Promise<TBuilder>;
}

/**
 * Define an application's entrypoint.
 *
 * Returns a callable the CLI and tests can import and invoke.
 * When the calling module is the Node entrypoint (`argv[1]`), schedules
 * an autorun: builds, compiles, awaits ready, then dispatches `Cli.run`
 * (if invoked with CLI args) or `BuiltApp.serve()`.
 */
export function defineApp<TEnv extends Environment, TBuilder>(
  meta: ImportMeta | { url: string },
  factory: AppFactory<TEnv, TBuilder>,
): DefinedApp<TEnv, TBuilder>;
export function defineApp<TEnv extends Environment = Environment, TBuilder = unknown>(
  meta: ImportMeta | { url: string },
  factory: AppFactory<TEnv, TBuilder>,
): DefinedApp<TEnv, TBuilder> {
  const callable = (async (envOverride?: TEnv) => {
    const env = envOverride ?? ((await loadEnvironment({ from: meta })) as TEnv);
    return await factory(env);
  }) as DefinedApp<TEnv, TBuilder>;

  if (isEntrypoint(meta) && !autorunFired) {
    autorunFired = true;
    // Don't block the caller's module evaluation - schedule a microtask.
    void (async () => {
      try {
        const env = (await loadEnvironment({ from: meta })) as TEnv;
        const builderLike = await callable(env);

        const built = (builderLike as { build: () => unknown }).build() as {
          compile: () => { ready: Promise<void> };
          serve: (opts?: { socketPath?: string; noSocket?: boolean }) => Promise<void>;
        };
        const app = built.compile();
        await app.ready;

        setCurrentApp({
          callable: callable as unknown as (env: Environment) => Promise<unknown>,
          env: env as Environment,
          entryUrl: meta.url,
          app: app as App,
        });

        const { Cli } = await import('./factory.js');
        if (Cli.isCommandLineRun()) {
          await Cli.run(app as any);
          return;
        }

        const noSocket = process.env.JUSTSCALE_NO_SOCKET === '1'
          || process.env.JUSTSCALE_NO_SOCKET === 'true';
        const socketPath = process.env.JUSTSCALE_SOCKET_PATH;
        await built.serve(noSocket ? { noSocket: true } : socketPath ? { socketPath } : undefined);
      } catch (err) {
        setImmediate(() => {
          throw err;
        });
      }
    })();
  }

  return callable;
}

function isEntrypoint(meta: ImportMeta | { url: string }): boolean {
  const entrypointArg = process.argv[1];
  if (!entrypointArg) return false;

  let metaPath: string;
  try {
    metaPath = fileURLToPath(meta.url);
  } catch {
    return false;
  }

  let entrypointReal: string;
  try {
    entrypointReal = realpathSync(entrypointArg);
  } catch {
    entrypointReal = entrypointArg;
  }

  return metaPath === entrypointArg || metaPath === entrypointReal;
}
