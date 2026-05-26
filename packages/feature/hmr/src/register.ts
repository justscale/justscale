/**
 * Main-thread entry for `--import @justscale/hmr/register`.
 *
 * Responsibilities:
 *
 * 1. **Spin up the loader worker.** Passes one end of a MessageChannel
 *    as the `port` so the worker can talk to main.
 *
 * 2. **Maintain the dep graph.** Every `{ type: 'loaded', url, parent }`
 *    message from the loader is recorded so we can later answer "which
 *    files transitively import `foo.ts`?". That's what lets us bump
 *    versions all the way up to the entry when a leaf file changes.
 *
 * 3. **Expose a bump API.** `bumpVersionForChange(filePath)` marks a
 *    canonical URL dirty (plus every ancestor that imported it) and
 *    pushes the new versions to the loader over the same port. The
 *    loader's `resolve` hook appends `?v=<version>` on subsequent
 *    resolutions — forcing Node to re-evaluate.
 *
 * 4. **Subscribe to `onContainerReady`.** Starts the watcher, which
 *    will call back here when files change.
 *
 * No globals. Everything is either process-scope module state or
 * lifecycled with the kernel.
 */

import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { onContainerReady } from '@justscale/core';
import { startHmrWatcher } from './watcher.js';

// ============================================================================
// Dep graph + version state
// ============================================================================

const loadedUrls = new Set<string>();

/**
 * Reverse dep graph: `child → set of parents that imported it`. Built
 * incrementally from `load` events. Every edge is a canonical URL
 * (no `?v=` suffix).
 */
const importers = new Map<string, Set<string>>();

/**
 * Current version per canonical URL. Missing key == version 0 ==
 * "no cache-bust on resolve". Bumps set the current timestamp so each
 * rebuild gets a monotonically-increasing identity that's also easy
 * to spot in logs.
 */
const versionMap = new Map<string, number>();

let loaderPort: import('node:worker_threads').MessagePort | null = null;
let nextSyncId = 1;
const pendingSyncs = new Map<number, () => void>();

const channel = new MessageChannel();
channel.port1.on('message', (msg: unknown) => {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as {
    type?: string
    url?: string
    child?: string
    parent?: string
    id?: number
  };
  if (m.type === 'loaded' && typeof m.url === 'string') {
    loadedUrls.add(m.url);
    return;
  }
  if (
    m.type === 'edge' &&
    typeof m.child === 'string' &&
    typeof m.parent === 'string' &&
    m.child !== m.parent
  ) {
    // Authoritative parent→child edge from the loader's resolve hook.
    let set = importers.get(m.child);
    if (!set) {
      set = new Set();
      importers.set(m.child, set);
    }
    set.add(m.parent);
    return;
  }
  if (m.type === 'syncAck' && typeof m.id === 'number') {
    const resolver = pendingSyncs.get(m.id);
    if (resolver) {
      pendingSyncs.delete(m.id);
      resolver();
    }
  }
});
channel.port1.start?.();
channel.port1.unref();

try {
  register('./loader.mjs', import.meta.url, {
    data: { port: channel.port2 },
    transferList: [channel.port2],
  });
  loaderPort = channel.port1;
} catch (err) {
  console.error('[hmr/register] register() failed:', err);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Snapshot of the canonical file URLs loaded so far. Callers should
 * treat the returned array as immutable — mutations won't propagate.
 */
export function getLoadedFiles(): string[] {
  return [...loadedUrls];
}

/**
 * All ancestors of the given canonical URL (files that transitively
 * imported it), including itself. Used to decide which files to bump
 * on a single-file change so the change propagates up to the entry.
 */
export function ancestorsOf(canonicalUrl: string): Set<string> {
  const result = new Set<string>();
  const stack = [canonicalUrl];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    const parents = importers.get(current);
    if (parents) {
      for (const p of parents) stack.push(p);
    }
  }
  return result;
}

/**
 * Mark the given file dirty (plus every ancestor). The loader's
 * resolve hook will start appending `?v=<newVersion>` to these URLs
 * on subsequent resolutions, forcing Node to re-evaluate.
 *
 * Returns the set of canonical URLs whose version was bumped.
 */
export function bumpVersionsForChange(filePath: string): Set<string> {
  const canonical = pathToFileURL(filePath).href;
  const ancestors = ancestorsOf(canonical);
  const newVersion = Date.now();
  for (const url of ancestors) {
    versionMap.set(url, newVersion);
    loaderPort?.postMessage({
      type: 'bumpVersion',
      canonicalUrl: url,
      version: newVersion,
    });
  }
  if (process.env.HMR_VERBOSE === '1') {
    process.stderr.write(`[hmr/register] bumped ${ancestors.size} url(s) for ${filePath}:\n`);
    for (const u of ancestors) process.stderr.write(`    ${u}\n`);
  }
  return ancestors;
}

/**
 * Current version for a canonical URL — useful for constructing a
 * cache-busted URL manually (e.g. when re-importing the entry).
 */
export function currentVersion(canonicalUrl: string): number {
  return versionMap.get(canonicalUrl) ?? 0;
}

/**
 * Ensure every `bumpVersion` message posted so far has been applied
 * by the loader worker. Send a `sync` message with a unique id; the
 * loader echoes back `syncAck` once its queue has drained past our
 * sync request, guaranteeing earlier bumps are in place. Main awaits
 * before calling `rebuildAndApply`, so the re-import's resolve pass
 * sees the new version map.
 */
export function syncWithLoader(timeoutMs = 2000): Promise<void> {
  if (!loaderPort) return Promise.resolve();
  const id = nextSyncId++;
  const port = loaderPort;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSyncs.delete(id);
      reject(new Error(`[hmr/register] loader sync timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingSyncs.set(id, () => {
      clearTimeout(timer);
      resolve();
    });
    port.postMessage({ type: 'sync', id });
  });
}

// ============================================================================
// Wire up the watcher
// ============================================================================

onContainerReady(async (container) => {
  await startHmrWatcher({
    container,
    root: process.cwd(),
  });
});
