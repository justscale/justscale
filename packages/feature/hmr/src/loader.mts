/**
 * HMR loader — observer + version-aware resolver.
 *
 * Runs in the Node loader worker. Two responsibilities:
 *
 * 1. **Observe** every `load()` event. Forward the URL and its
 *    parent URL to the main thread so the watcher knows what was
 *    loaded and which file imported it.
 *
 * 2. **Rewrite resolve** so `import './foo.js'` becomes
 *    `./foo.js?v=<currentVersion>` whenever the main thread has
 *    marked `./foo.js` dirty. Node's ESM cache keys by full URL
 *    including query, so bumping the version forces a fresh load the
 *    next time that URL is resolved — which happens when the caller
 *    (the re-imported entry, etc.) re-links.
 *
 * The version map is mirrored from main to loader via a
 * `MessagePort` message channel. Main sends
 * `{ type: 'bumpVersion', canonicalUrl }`; loader updates its map.
 * Loader sends `{ type: 'loaded', url, parent }` whenever `load`
 * fires; main uses that to build the dependency graph.
 *
 * URLs in the version map are **canonical** (no `?v=` suffix). Every
 * canonicalisation is done by stripping `?v=...` via a small helper.
 */

import type { MessagePort } from 'node:worker_threads';

interface LoaderInitData {
  port: MessagePort
}

interface ResolveContext {
  parentURL?: string
  conditions?: string[]
  importAttributes?: Record<string, string>
}

interface ResolveResult {
  url: string
  format?: string | null
  shortCircuit?: boolean
  importAttributes?: Record<string, string>
}

type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

interface LoadContext {
  format?: string | null
  conditions?: string[]
  importAttributes?: Record<string, string>
}

interface LoadResult {
  format: string
  source?: string | ArrayBuffer | Uint8Array | null
  shortCircuit?: boolean
}

type NextLoad = (url: string, context: LoadContext) => Promise<LoadResult>;

type MainMessage =
  | { type: 'bumpVersion'; canonicalUrl: string; version: number }
  | { type: 'sync'; id: number };

let relayPort: MessagePort | null = null;
const versionMap = new Map<string, number>();

function canonicalize(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function withVersion(canonicalUrl: string, version: number): string {
  if (version === 0) return canonicalUrl;
  return `${canonicalUrl}?v=${version}`;
}

export function initialize(data: LoaderInitData): void {
  relayPort = data.port;
  relayPort.on('message', (msg: MainMessage) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'bumpVersion') {
      versionMap.set(msg.canonicalUrl, msg.version);
    } else if (msg.type === 'sync') {
      // Echo back so main knows every earlier `bumpVersion` has
      // been applied. Main awaits the echo before running a rebuild,
      // preventing races where the re-import resolves stale URLs
      // because messages hadn't flushed through the worker queue.
      relayPort?.postMessage({ type: 'syncAck', id: msg.id });
    }
  });
  relayPort.start?.();
  relayPort.unref();
}

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  const defaultResult = await nextResolve(specifier, context);
  const isWatchableFile =
    defaultResult.url.startsWith('file:') &&
    !defaultResult.url.includes('/node_modules/');

  // Report the real parent→child edge to main, so `ancestorsOf` can
  // walk precise import relationships (instead of guessing from
  // module load order).
  if (
    relayPort &&
    isWatchableFile &&
    context.parentURL &&
    context.parentURL.startsWith('file:') &&
    !context.parentURL.includes('/node_modules/')
  ) {
    try {
      relayPort.postMessage({
        type: 'edge',
        child: canonicalize(defaultResult.url),
        parent: canonicalize(context.parentURL),
      });
    } catch { /* port died */ }
  }

  if (!isWatchableFile) return defaultResult;
  const canonical = canonicalize(defaultResult.url);
  const version = versionMap.get(canonical);
  if (!version) return defaultResult;
  return { ...defaultResult, url: withVersion(canonical, version), shortCircuit: true };
}

export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad,
): Promise<LoadResult> {
  if (
    relayPort &&
    url.startsWith('file:') &&
    !url.includes('/node_modules/')
  ) {
    try {
      relayPort.postMessage({ type: 'loaded', url: canonicalize(url) });
    } catch { /* port died, keep loading */ }
  }
  return nextLoad(url, context);
}
