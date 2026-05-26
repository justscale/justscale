/**
 * Rebuild-and-diff — the v3 HMR core.
 *
 * Flow on a file change:
 *
 *   1. Main already bumped versions for the changed file + ancestors
 *      (`register.bumpVersionsForChange`). The loader's resolve hook
 *      will now append `?v=<newVersion>` to every import of those
 *      canonical URLs.
 *
 *   2. We re-import the app entry (`getCurrentApp().entryUrl`) with
 *      a cache-bust query. Node sees a new URL, re-evaluates the
 *      module. Its `import { ... } from '...'` statements flow
 *      through our loader; dirty URLs get the new `?v=` suffix and
 *      re-evaluate too; clean URLs resolve to the already-cached
 *      module. Fresh classes bubble up through the graph.
 *
 *   3. The fresh `defineApp` default export's `callable(env)` returns
 *      a new builder. We `.build()` + `await ready` it — giving us a
 *      brand-new container with fresh factories. We don't serve this
 *      app; it's a throwaway used only for diffing.
 *
 *   4. Walk the new container's registered services, match each
 *      against the old container by **stable ID** (file#exportName —
 *      the HMR watcher populated both sides at boot). For each
 *      match: `container[CONTAINER_DEV].replaceInstance(oldToken,
 *      newFactory)`. For newly-added services: register them fresh.
 *      For services that disappeared: log (we leave the stale cached
 *      instance alone for now — tearing it down is a future refinement).
 *
 *   5. Extensive logging at every step. This is the "insane HMR" the
 *      user asked for, so they should be able to see exactly what's
 *      happening on every file change.
 */

import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTAINER_DEV,
  getCurrentApp,
  isControllerDef,
  type App,
  type Container,
  type ContainerDevExtensions,
  type ControllerDef,
  type ControllerInstance,
  type Logger,
  type ServiceDef,
} from '@justscale/core';

interface ServiceEntry {
  token: unknown
  factory: (deps: unknown, resolve: unknown) => unknown
}

interface RebuildContext {
  /**
   * Root container. Used as the registration target for newly-added
   * root-scope services/controllers. Per-stable-id replacements
   * dispatch through `stableIdToToken[id].container` instead — sub-app
   * services live on a different container than the root.
   */
  liveContainer: Container
  /**
   * Map of stable ID → { old token, owning container }. Populated by
   * the watcher at boot across every container in the app tree (root
   * + sub-apps), and kept in sync as services are added. The container
   * is the one whose `CONTAINER_DEV.replaceInstance` must be called to
   * swap the factory in-place.
   */
  stableIdToToken: Map<string, { token: unknown; container: Container }>
  /** Project root — for formatting paths in log output. */
  root: string
  /** Framework Logger, scoped by the watcher to name='hmr'. Level-gated
   * via `setMinLogLevel` / `just log level <x>`; instrumentation hooks
   * fire through the usual observability surface. */
  logger: Logger
  /** Return true if a class export from a module looks like a service. */
  looksLikeService: (value: unknown) => boolean
  /** Relative-path-of stable ID; passed in so we reuse the watcher's
   * existing resolveToSrc logic for workspace packages. */
  resolveToSrc: (url: string) => string | null
  /** The current list of loaded files after rebuild, so new services
   * can be registered correctly. */
  getLoadedFiles: () => string[]
  /** The register.ts `currentVersion` accessor, for building the
   * cache-busted entry URL. */
  currentVersion: (canonicalUrl: string) => number
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export interface RebuildResult {
  /** Number of services whose behavior was swapped on the live container. */
  replaced: number
  /** Newly-registered services that didn't exist at boot. */
  added: number
  /** Services that disappeared in the new build. */
  removed: number
  /** File paths that changed (for logging). */
  dirtyFiles: string[]
}

export async function rebuildAndApply(
  ctx: RebuildContext,
): Promise<RebuildResult> {
  const started = Date.now();
  const { logger } = ctx;
  const current = getCurrentApp();
  if (!current) {
    logger.warn('rebuild skipped — no current app registered yet');
    return { replaced: 0, added: 0, removed: 0, dirtyFiles: [] };
  }

  // Canonicalise the entry URL (strip any pre-existing ?v=) before
  // appending a fresh bust — otherwise subsequent rebuilds stack
  // `?v=X?v=Y` segments.
  const canonicalEntry = current.entryUrl.split('?')[0]!;
  const entryVersion = ctx.currentVersion(canonicalEntry);
  const entryWithBust = entryVersion > 0
    ? `${canonicalEntry}?v=${entryVersion}`
    : `${canonicalEntry}?v=${Date.now()}`;
  const entryUrl = canonicalEntry;

  logger.info(`rebuilding — entry ${entryUrl} @ v=${entryVersion || Date.now()}`);

  let freshMod: Record<string, unknown>;
  try {
    freshMod = (await import(entryWithBust)) as Record<string, unknown>;
  } catch (err) {
    logger.error(`rebuild failed during re-import — ${formatErr(err)}`);
    return { replaced: 0, added: 0, removed: 0, dirtyFiles: [] };
  }

  const freshDefault = freshMod.default as unknown;
  if (typeof freshDefault !== 'function') {
    logger.error("rebuild failed — entry's default export isn't callable");
    return { replaced: 0, added: 0, removed: 0, dirtyFiles: [] };
  }

  // Invoke the fresh callable with the same env. Its static imports
  // go through our loader's resolve hook — dirty URLs get bumped
  // versions and re-evaluate, clean URLs reuse the cached module.
  let newBuilderLike: { addControllers?: unknown; build?: unknown };
  try {
    newBuilderLike = (await (freshDefault as (e: unknown) => Promise<unknown>)(
      current.env,
    )) as typeof newBuilderLike;
  } catch (err) {
    logger.error(`rebuild failed during factory invocation — ${formatErr(err)}`);
    return { replaced: 0, added: 0, removed: 0, dirtyFiles: [] };
  }

  if (!newBuilderLike || typeof newBuilderLike.build !== 'function') {
    logger.error("rebuild failed — factory didn't return a builder");
    return { replaced: 0, added: 0, removed: 0, dirtyFiles: [] };
  }

  // Build the throwaway app so all factories are present and
  // type-matched. We DON'T run `app.ready` on it — resolving
  // everything would run every service's factory prematurely,
  // potentially starting connections / adapters we don't want.
  // Walking `container.factories` is enough to match services up.
  let newApp: {
    app: {
      container: Container & {
        factories?: Map<unknown, { factory: unknown; deps?: unknown }>
      }
    }
  };
  try {
    newApp = (newBuilderLike.build as () => typeof newApp)();
  } catch (err) {
    logger.error(`rebuild failed during build() — ${formatErr(err)}`);
    return { replaced: 0, added: 0, removed: 0, dirtyFiles: [] };
  }

  const newFactoriesByStableId = await collectNewServices(newApp.app.container, ctx);
  logger.trace(
    `  collectNewServices saw ${newFactoriesByStableId.size} exports; ` +
    `live map has ${ctx.stableIdToToken.size}`,
  );
  for (const sid of newFactoriesByStableId.keys()) {
    logger.trace(`    ${sid} (known: ${ctx.stableIdToToken.has(sid)})`);
  }

  // `current.app` was populated by `defineApp` after `app.ready` so
  // HMR can mutate the live controllers array when new controllers
  // appear in the rebuilt graph. If the entrypoint didn't register an
  // app (rare — non-`defineApp` startups), fall back to
  // replace-and-log-only for controllers.
  const liveApp: App | null = (current as { app?: App }).app ?? null;

  let replaced = 0;
  let added = 0;
  const seenOnOld = new Set<string>();

  for (const [stableId, entry] of newFactoriesByStableId) {
    const oldEntry = ctx.stableIdToToken.get(stableId);
    if (oldEntry) {
      seenOnOld.add(stableId);
      const { token: oldToken, container: owning } = oldEntry;
      const oldFactory = (oldToken as { factory?: unknown }).factory;

      // If the factory reference is identical, the module wasn't
      // re-evaluated — this service's code didn't change. Skip; no
      // need to re-run or log.
      if (oldFactory === entry.factory) continue;

      // Mutate the old class so future re-runs of def.factory on the
      // old token see the new code.
      try {
        const oldClass = oldToken as Record<string | symbol, unknown>;
        oldClass.factory = entry.factory;
      } catch { /* not mutable — live with stale factory */ }
      try {
        // Dispatch to the owning container's dev surface. Sub-app
        // services live on the sub-app's container, not the root —
        // swapping there runs the replacement in the right scope.
        const owningDev: ContainerDevExtensions = owning[CONTAINER_DEV];
        await owningDev.replaceInstance(oldToken, entry.factory);
        replaced++;
        logger.info(`  replaced ${stableId}`);
      } catch (err) {
        logger.error(`  ${stableId}: replace failed — ${formatErr(err)}`);
      }
    } else {
      // A stable ID we've never seen before. Two cases matter:
      //
      //  1. **Controller newly .add()'d in the entry or a feature** —
      //     resolve against the live container, push the instance into
      //     `liveApp.controllers`. From that point forward the app's
      //     route iteration (`app.match`, `CliService.listCommands`)
      //     sees it, so the new routes / commands light up without a
      //     restart.
      //
      //  2. **Service newly .add()'d** — register the def with the
      //     live container so anyone who goes on to resolve it
      //     (including controllers added later) gets the real factory.
      //     Services with no consumers stay dormant, which is fine.
      //
      // Either way, we record the stable ID on the live container so
      // the next rebuild treats it as an existing service to replace,
      // not an add. That's what makes the cost "one new ID up front,
      // then every subsequent edit is a normal method-patch".
      //
      // Exports that aren't actually registered by the new build
      // (helper classes, type guards, process-def instances) show up
      // here too. They aren't in `newApp.app.container`, so we leave
      // them alone — nothing called `.add(X)` on them.
      const newDef = entry.token as ControllerDef<any> | ServiceDef<unknown, any>;
      const newContainer = newApp.app.container;
      const registeredInNew = (newContainer[CONTAINER_DEV] as ContainerDevExtensions)
        .hasServiceDef(newDef);
      logger.trace(
        `  ${stableId} registered=${registeredInNew} ` +
        `controller=${isControllerDef(newDef)}`,
      );
      if (!registeredInNew) {
        // Exported but not added to the DI graph. Not our concern.
        continue;
      }

      try {
        if (isControllerDef(newDef)) {
          if (!liveApp) {
            logger.warn(`  ${stableId}: new controller detected but no live App registered — run \`just dev\` to enable`);
            continue;
          }
          (ctx.liveContainer as unknown as { register: (d: unknown) => void })
            .register(newDef);
          const instance = await ctx.liveContainer.resolve(newDef as any) as ControllerInstance<any>;
          (instance as { __def?: unknown }).__def = newDef;
          liveApp.controllers.push(instance);
          logger.info(`  added controller ${stableId} (routes=${instance.routes.length})`);
        } else {
          (ctx.liveContainer as unknown as { register: (d: unknown) => void })
            .register(newDef);
          logger.info(`  added service ${stableId}`);
        }

        // New-service additions are registered on the root container
        // only. Detecting which sub-app scope should own a brand-new
        // def would require compiling the throwaway parent's sub-apps,
        // which the compose loop skips (they're module-level
        // singletons). Pragmatic limitation: new services added inside
        // a sub-app require a restart.
        ctx.stableIdToToken.set(stableId, {
          token: newDef,
          container: ctx.liveContainer,
        });
        try {
          (ctx.liveContainer[CONTAINER_DEV] as ContainerDevExtensions)
            .registerStableId(stableId, newDef);
        } catch { /* some containers lack this; tolerated */ }
        added++;
      } catch (err) {
        logger.error(`  ${stableId}: add failed — ${formatErr(err)}`);
      }
    }
  }

  let removed = 0;
  for (const stableId of ctx.stableIdToToken.keys()) {
    if (!seenOnOld.has(stableId) && !newFactoriesByStableId.has(stableId)) {
      // Service no longer exists in the new build. We don't forcibly
      // dispose the instance — callers holding a reference keep
      // working with the old behaviour until process restart. Warn
      // so the user notices — this is a known gap, not a bug.
      logger.warn(`  removed ${stableId} (old instance kept alive)`);
      removed++;
    }
  }

  const elapsed = Date.now() - started;
  logger.info(
    `rebuild complete in ${elapsed}ms — ` +
    `replaced=${replaced} added=${added} removed=${removed}`,
  );

  return { replaced, added, removed, dirtyFiles: [] };
}

/**
 * Walk every loaded file in the newly-rebuilt app's container and
 * extract `{ stableId, token, factory }` for each exported service
 * class. Uses the same stable-ID convention as the watcher's boot
 * walk: `<srcRelPath>#<exportName>`.
 */
async function collectNewServices(
  newContainer: Container & {
    factories?: Map<unknown, { factory: unknown; deps?: unknown }>
  },
  ctx: RebuildContext,
): Promise<Map<string, ServiceEntry>> {
  const result = new Map<string, ServiceEntry>();
  const verbose = process.env.HMR_VERBOSE === '1';

  const loaded = ctx.getLoadedFiles();
  let matched = 0;
  for (const url of loaded) {
    const filepath = ctx.resolveToSrc(url);
    if (filepath === null) continue;

    let mod: Record<string, unknown>;
    try {
      const canonicalUrl = url;
      const version = ctx.currentVersion(canonicalUrl);
      const withBust = version > 0 ? `${canonicalUrl}?v=${version}` : canonicalUrl;
      mod = (await import(withBust)) as Record<string, unknown>;
    } catch {
      continue;
    }

    const relPath = relative(ctx.root, filepath).replace(/\\/g, '/');
    for (const [name, exported] of Object.entries(mod)) {
      if (!ctx.looksLikeService(exported)) continue;
      // We don't gate on `dev.hasServiceDef(exported)` here. The new
      // container might not have this exact reference (subtle cache
      // timing during rebuild), but since we only care about services
      // the OLD container had — matched later by stable ID against
      // `ctx.stableIdToToken` — it doesn't matter if the new container
      // knows about them. Collecting every service-like export by
      // stable ID is enough.
      matched++;
      const stableId = `${relPath}#${name}`;
      result.set(stableId, {
        token: exported,
        factory: (exported as { factory: (deps: unknown, resolve: unknown) => unknown }).factory,
      });
    }
  }

  if (verbose) {
    process.stderr.write(`[hmr/rebuild] collectNewServices: ${matched} matched\n`);
  }

  return result;
}

/**
 * Small export for the watcher: canonical URL from a file path.
 */
export function canonicalUrlFor(filepath: string): string {
  return pathToFileURL(filepath).href;
}
