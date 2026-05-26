/**
 * HMR file watcher.
 *
 * Driven by the observer loader (`./loader.mts`) which records every
 * `file:` URL Node loaded. After app boot we ask the registry which
 * files the running process actually depends on, derive the unique
 * parent directories, and watch exactly those. That's how the watcher
 * correctly scopes to `examples/simple-app/src/` plus whichever
 * workspace packages' source (or dist) got loaded, without walking the
 * entire repo.
 *
 * Per-file change path:
 *
 *   1. `fs.watch` sees a touch (debounced per-file).
 *   2. Cache-bust re-import the file so Node loads the new source.
 *      Source maps survive because the re-import still flows through
 *      the same loader chain (`@justscale/typescript/register`, tsx).
 *   3. For every exported service class in the new module that was
 *      registered on the container at boot, mutate the old class
 *      object so `.factory` / `.deps` point at the new ones. Future
 *      `container.resolve()` calls (and `replaceInstance`'s factory
 *      re-run) pick up the new code.
 *   4. Call `container.replaceInstance(oldToken, newFactory)`. For
 *      object-returning factories that does a delete-then-Object.assign
 *      onto the live instance. For function-returning factories, it
 *      updates the indirection proxy's inner pointer. Handlers that
 *      closed over the instance reference see new behaviour on their
 *      next call.
 */

import { watch } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Logger is the framework's DI-native observability primitive; the
// watcher receives the container it's attached to, so a scoped child
// logger (name='hmr') drops us into the same level-gated, context-
// aware log stream as everything else. No bespoke severity helper.
import {
  CONTAINER_DEV,
  Lifecycle,
  Logger,
  getCurrentApp,
  setHmrContainer,
  type App,
  type Container,
  type ContainerDevExtensions,
} from '@justscale/core';

// ============================================================================
// Types
// ============================================================================

export interface HmrWatcherOptions {
  /** DI container whose services get replaced on change. */
  container: Container

  /** Project root for computing stable IDs (`<relPath>#<exportName>`). */
  root: string

  /**
   * Optional logger override. Defaults to the container's `Logger`
   * scoped to `hmr`. Tests pass their own to capture output.
   */
  logger?: Logger

  /** Debounce window per file in ms. Default 150. */
  debounceMs?: number
}

export interface HmrWatcherHandle {
  /** Stop watching and clear pending timers. */
  stop(): Promise<void>
}

interface ServiceExport {
  stableId: string
  token: unknown
}

// ============================================================================
// Utilities
// ============================================================================

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function isSourceFile(fileName: string): boolean {
  // Skip editor "atomic save" temp files. JetBrains, vim swap files,
  // and similar tools briefly create/rename files with patterns like
  // `.!12345!orig.ts` or `4913` or `.orig.ts.swp` next to the real
  // file. fs.watch fires for these; treating them as real changes
  // triggers spurious rebuilds.
  const base = fileName.split('/').pop() ?? fileName;
  if (base.startsWith('.!')) return false;
  if (base.startsWith('.') && (base.endsWith('.swp') || base.endsWith('~'))) return false;
  if (/^\d+$/.test(base)) return false;
  return SOURCE_EXTENSIONS.has(extname(fileName));
}

function looksLikeService(value: unknown): boolean {
  // Two shapes to recognise:
  //  - `defineService({...})` returns a ServiceImpl function class with
  //    `.factory` attached. `typeof value === 'function'`.
  //  - `createController({...})` returns a plain `{ deps, factory }`
  //    object. Its factory builds a ControllerInstance (routes +
  //    deps). We need to swap these too on HMR so route-table
  //    changes propagate.
  if (!value || (typeof value !== 'function' && typeof value !== 'object')) return false;
  const v = value as { factory?: unknown };
  return typeof v.factory === 'function';
}

// ============================================================================
// Workspace dist→src mapping
// ============================================================================

/**
 * If `filepath` is under a workspace package whose `package.json`
 * declares `exports[...].source` entries pointing at `./src/*`, map
 * `<pkgRoot>/dist/X.js` → `<pkgRoot>/src/X.ts` (or `.mts`). Returns
 * null when the package has no source map OR when the corresponding
 * src file doesn't exist on disk.
 *
 * Cached per package root so we don't re-parse package.json per file.
 *
 * Enables monorepo HMR: when the running app loaded
 * `packages/adapters/postgres/dist/feature.js`, the watcher watches
 * `packages/adapters/postgres/src/feature.ts` instead and maps the
 * src edits through to the dist-loaded service token.
 */

/**
 * For each workspace package we hit, read `package.json` once and
 * collect every (`source`, `import`) pair from its `exports` map
 * into a direct absolute-path lookup:
 *
 *   /mono/packages/X/dist/index.js  →  /mono/packages/X/src/index.ts
 *   /mono/packages/X/dist/cli.js    →  /mono/packages/X/src/cli.ts
 *
 * If a loaded file IS in the map, that's its src. If it isn't, we
 * fall back to the first pair's directory + extension rule —
 * `exports['.'].source = './src/index.ts'` plus
 * `exports['.'].import = './dist/index.js'` tells us that inside this
 * package, `./dist/<rest>.js` pairs with `./src/<rest>.ts` for
 * arbitrary `<rest>`. Same idea when the package puts TS + JS
 * side-by-side (`./index.ts` ↔ `./index.js`): the rule degenerates to
 * "swap the extension".
 *
 * That's "use what package.json tells us" + a minimal extrapolation
 * for transitive internal imports that aren't listed in exports.
 */

interface PackageMap {
  /** Direct lookup for explicitly-exported entries. */
  readonly direct: Map<string, string>
  /** Inferred pattern for unlisted internal files (derived from one pair). */
  readonly pattern: { importPrefix: string; sourcePrefix: string; sourceExt: string } | null
}

const packageMapCache = new Map<string, PackageMap>();

function packageRootFor(filepath: string): string | null {
  let dir = dirname(filepath);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

function packageMap(pkgRoot: string): PackageMap {
  const cached = packageMapCache.get(pkgRoot);
  if (cached) return cached;

  const direct = new Map<string, string>();
  let pattern: PackageMap['pattern'] = null;

  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as {
      exports?: Record<string, unknown>
    };
    const exports = pkg.exports;
    if (exports && typeof exports === 'object') {
      for (const value of Object.values(exports)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as { source?: unknown; import?: unknown };
        const source = v.source;
        const imp = v.import;
        if (typeof source !== 'string' || typeof imp !== 'string') continue;
        if (!source.startsWith('./') || !imp.startsWith('./')) continue;

        const absImport = pathResolve(pkgRoot, imp);
        const absSource = pathResolve(pkgRoot, source);
        if (existsSync(absSource)) {
          direct.set(absImport, absSource);
        }

        if (pattern === null) {
          pattern = {
            importPrefix: dirname(imp) === '.' ? './' : dirname(imp) + '/',
            sourcePrefix: dirname(source) === '.' ? '' : dirname(source).slice(2) + '/',
            sourceExt: extname(source),
          };
        }
      }
    }
  } catch {
    // malformed package.json; leave both empty
  }

  const map: PackageMap = { direct, pattern };
  packageMapCache.set(pkgRoot, map);
  return map;
}

/**
 * Normalise a loaded file URL to its workspace-src path where
 * available, otherwise return the dist file path unchanged.
 *
 *  1. Resolve to an absolute file path.
 *  2. Find the enclosing package.json.
 *  3. If this file is a listed exports entry, use that entry's source.
 *  4. Else, if the package has at least one (source, import) pair, use
 *     the directory + extension pattern derived from it.
 *  5. Else, return the dist path unchanged.
 */
function resolveToSrc(url: string): string | null {
  let filepath: string;
  try {
    filepath = fileURLToPath(url);
  } catch {
    return null;
  }
  const pkgRoot = packageRootFor(filepath);
  if (!pkgRoot) return filepath;

  const map = packageMap(pkgRoot);

  // 1. Exact listed mapping wins.
  const direct = map.direct.get(filepath);
  if (direct) return direct;

  // 2. Pattern fallback for internal imports.
  if (map.pattern) {
    const rel = './' + relative(pkgRoot, filepath).replace(/\\/g, '/');
    if (rel.startsWith(map.pattern.importPrefix)) {
      const rest = rel.slice(map.pattern.importPrefix.length);
      const baseNoExt = rest.replace(/\.(js|mjs|cjs)$/, '');
      const candidates = [
        map.pattern.sourcePrefix + baseNoExt + map.pattern.sourceExt,
        map.pattern.sourcePrefix + baseNoExt + '.ts',
        map.pattern.sourcePrefix + baseNoExt + '.mts',
        map.pattern.sourcePrefix + baseNoExt + '.cts',
        map.pattern.sourcePrefix + baseNoExt + '.tsx',
      ];
      for (const candidate of candidates) {
        const abs = join(pkgRoot, candidate);
        if (existsSync(abs)) return abs;
      }
    }
  }

  return filepath;
}

/**
 * Pull the list of loaded file URLs from `@justscale/hmr/register`.
 * If register wasn't loaded (e.g. someone imported the watcher without
 * the loader hook in their `--import` chain), fall back to an empty
 * list and log a warning.
 */
function formatErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

async function getLoadedFiles(logger: Logger): Promise<string[]> {
  try {
    const reg = (await import('./register.js')) as { getLoadedFiles?: () => string[] };
    if (typeof reg.getLoadedFiles === 'function') {
      return reg.getLoadedFiles();
    }
  } catch (err) {
    logger.warn(`loader registry not available — ${formatErr(err)}`);
  }
  return [];
}

/**
 * Given URLs the app actually loaded, compute the minimal set of
 * directories to watch.
 */
function deriveWatchRoots(filepaths: string[], projectRoot: string): string[] {
  const dirs = new Set<string>();
  for (const p of filepaths) {
    if (!isSourceFile(p)) continue;
    dirs.add(dirname(p));
  }
  dirs.add(pathResolve(projectRoot));
  return [...dirs];
}

// ============================================================================
// Watcher
// ============================================================================

const NOOP_HANDLE: HmrWatcherHandle = { async stop() { /* already-stopped */ } };

// Guard against double-start — the watcher is triggered by
// `onContainerReady`, which could fire more than once if a rebuild
// surfaces an additional container-ready path. Only the FIRST watcher
// is meaningful; subsequent calls no-op.
let started = false;

export async function startHmrWatcher(
  opts: HmrWatcherOptions,
): Promise<HmrWatcherHandle> {
  if (started) return NOOP_HANDLE;
  started = true;

  const {
    container,
    root,
    logger: providedLogger,
    debounceMs = 150,
  } = opts;

  // Child logger named 'hmr'. `createLogger` runs through whatever
  // `LoggerFactory` the container has — the default ConsoleLogger,
  // or whatever Pino/Winston/OT factory a user swapped in. Level
  // gating (`setMinLogLevel`), instrumentation hooks, and request
  // context all flow through automatically.
  const logger = providedLogger ?? container.createLogger('hmr');

  setHmrContainer(container);

  // Collect every container in the app tree (root + sub-apps,
  // recursively). Sub-apps keep their own scope: services/controllers
  // added inside a sub-app live on its container, not the parent's.
  // HMR needs each of them so a file change inside a sub-app swaps
  // the factory on the right container rather than silently missing.
  //
  // `getCurrentApp()` is populated by `defineApp` after `await app.ready`,
  // which includes the sub-app compose chain — so by the time
  // `onContainerReady` fires (during serve), the tree is fully wired.
  // Fallback to root-only if current app isn't registered (non-defineApp
  // bootstraps, bespoke test harnesses).
  const liveApp = getCurrentApp()?.app as App | undefined;
  const allContainers: Container[] = [container];
  if (liveApp) {
    const queue: App[] = [...liveApp.subApps];
    while (queue.length > 0) {
      const sub = queue.shift()!;
      if (!allContainers.includes(sub.container)) {
        allContainers.push(sub.container);
      }
      queue.push(...sub.subApps);
    }
  }

  // stableId -> { token, container }. The OLD class reference is
  // preserved; we mutate .factory/.deps on it, never replace the
  // reference. `container` identifies which scope owns the token so
  // rebuild dispatches `replaceInstance` to the right `CONTAINER_DEV`.
  //
  // Models don't need a parallel map: `defineModel` now stamps
  // MODEL_STABLE_ID on the class itself, so `ModelRepository.of(...)`
  // auto-resolves the same token across class-ref swaps. No HMR-side
  // bookkeeping required — identity flows through `defineModel`.
  const stableIdToToken = new Map<string, { token: unknown; container: Container }>();

  // file path -> services exported from it.
  const fileToExports = new Map<string, ServiceExport[]>();

  const pending = new Map<string, NodeJS.Timeout>();
  const abort = new AbortController();

  // --------------------------------------------------------------------------
  // Boot: ask the loader registry what got loaded, map services.
  // --------------------------------------------------------------------------

  // The observer loader posts every URL async over a MessagePort. By
  // the time the kernel fires container-ready, some of those messages
  // may still be queued — give the event loop one tick to drain them
  // before we snapshot the set.
  await new Promise<void>((r) => setImmediate(r));

  const loaded = await getLoadedFiles(logger);
  let servicesMapped = 0;
  let workspaceMapped = 0;
  const allFilepaths: string[] = [];
  for (const url of loaded) {
    // If the URL belongs to a workspace package with a `source` export,
    // resolve to the .ts source instead of the dist.js that was loaded.
    // We watch the src path and compute stable IDs against it, so an
    // edit to `packages/X/src/foo.ts` hits the service that was
    // originally resolved from `packages/X/dist/foo.js`.
    const filepath = resolveToSrc(url);
    if (filepath === null) continue;
    if (!isSourceFile(filepath)) continue;
    allFilepaths.push(filepath);

    // Import the LOADED URL (what the container actually has in its
    // factories). Node returns the cached module. We need the module
    // exports so we can match them against container-registered tokens.
    let mod: Record<string, unknown>;
    try {
      mod = (await import(url)) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (filepath !== fileURLToPath(url)) workspaceMapped++;

    const relPath = relative(root, filepath).replace(/\\/g, '/');
    const exports: ServiceExport[] = [];
    for (const [name, exported] of Object.entries(mod)) {
      if (!looksLikeService(exported)) continue;
      // A service export might live on the root container or on any
      // sub-app's container. Probe each in tree-declaration order
      // (root first, then sub-apps). First hit wins — a def can only
      // be registered on one container.
      let owning: Container | null = null;
      for (const c of allContainers) {
        if ((c[CONTAINER_DEV] as ContainerDevExtensions).hasServiceDef(exported)) {
          owning = c;
          break;
        }
      }
      if (!owning) continue;
      const stableId = `${relPath}#${name}`;
      stableIdToToken.set(stableId, { token: exported, container: owning });
      (owning[CONTAINER_DEV] as ContainerDevExtensions).registerStableId(stableId, exported);
      exports.push({ stableId, token: exported });
      servicesMapped++;
    }
    if (exports.length > 0) {
      fileToExports.set(filepath, exports);
    }
  }

  const watchRoots = deriveWatchRoots(allFilepaths, root);
  logger.info(
    `mapped ${servicesMapped} service(s) across ${fileToExports.size} file(s) ` +
    `(${workspaceMapped} via workspace package.json source maps); ` +
    `watching ${watchRoots.length} directory tree(s)`,
  );

  // --------------------------------------------------------------------------
  // Per-file change handler
  // --------------------------------------------------------------------------

  async function handleChange(absPath: string): Promise<void> {
    // Bump versions for the changed file + every ancestor that
    // transitively imported it. The loader's resolve hook will now
    // append `?v=<newVersion>` when those URLs come up again.
    let bumped: Set<string>;
    let syncWithLoader: ((ms?: number) => Promise<void>) | null = null;
    let currentVersion: ((u: string) => number) | null = null;
    let getLoadedFilesFn: (() => string[]) | null = null;
    try {
      const reg = (await import('./register.js')) as {
        bumpVersionsForChange: (p: string) => Set<string>
        syncWithLoader: (ms?: number) => Promise<void>
        currentVersion: (u: string) => number
        getLoadedFiles: () => string[]
      };
      bumped = reg.bumpVersionsForChange(absPath);
      syncWithLoader = reg.syncWithLoader;
      currentVersion = reg.currentVersion;
      getLoadedFilesFn = reg.getLoadedFiles;
    } catch {
      bumped = new Set();
    }
    logger.info(`${relative(root, absPath)} changed — bumping ${bumped.size} url(s) in dep chain`);

    // Wait for the loader worker to acknowledge the bumps before
    // re-importing. Without this, the re-import's resolve pass can
    // race ahead of the version map and return stale URLs.
    if (syncWithLoader) {
      try {
        await syncWithLoader();
      } catch (err) {
        logger.warn(`loader sync failed — ${formatErr(err)}`);
      }
    }

    // No model-specific pre-pass: `defineModel` stamps the stable ID
    // on the class itself, so when the re-imported app.ts calls
    // `ModelRepository.of(newOrder)`, the token memoisation returns
    // the same token (plus auto-updates its internal class ref).
    // Model changes "just flow" through the DI binding graph like
    // any other dependency.

    // Run the full rebuild + diff + apply.
    try {
      const { rebuildAndApply } = await import('./rebuild.js');
      await rebuildAndApply({
        liveContainer: container,
        stableIdToToken,
        root,
        logger,
        looksLikeService,
        resolveToSrc,
        getLoadedFiles: getLoadedFilesFn ?? (() => []),
        currentVersion: currentVersion ?? (() => 0),
      });
    } catch (err) {
      logger.error(`rebuild threw — ${formatErr(err)}`);
    }
  }

  function scheduleChange(absPath: string): void {
    const existing = pending.get(absPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(absPath);
      void handleChange(absPath);
    }, debounceMs);
    pending.set(absPath, timer);
  }

  // --------------------------------------------------------------------------
  // Watch loops — one per unique directory returned by deriveWatchRoots.
  // --------------------------------------------------------------------------

  const watchLoops: Promise<void>[] = [];
  for (const dir of watchRoots) {
    watchLoops.push((async () => {
      let watcher: AsyncIterable<{ eventType: string; filename: string | null }>;
      try {
        watcher = watch(dir, { recursive: true, signal: abort.signal });
      } catch (err) {
        logger.warn(`could not watch ${dir} — ${formatErr(err)}`);
        return;
      }
      try {
        for await (const event of watcher) {
          if (!event.filename) continue;
          if (!isSourceFile(event.filename)) continue;
          scheduleChange(pathResolve(dir, event.filename));
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        logger.error(`watcher loop error on ${dir} — ${formatErr(err)}`);
      }
    })());
  }

  const handle: HmrWatcherHandle = {
    async stop(): Promise<void> {
      abort.abort();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      await Promise.all(watchLoops);
    },
  };

  // Register with the app's lifecycle so `just dev` Ctrl-C cleans up
  // the watcher alongside adapter stop hooks. Failure here is not
  // fatal — worst case the watcher lingers until process exit.
  try {
    const lifecycle = (await container.resolve(Lifecycle)) as {
      register: (hook: 'stop', fn: () => Promise<void> | void) => void
    };
    lifecycle.register('stop', () => handle.stop());
  } catch {
    // Lifecycle not registered in this container.
  }

  return handle;
}
