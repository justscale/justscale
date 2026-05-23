import { MODEL_INTERNALS, OBSERVABLE_META } from './symbols.js';
import type { Model, Observable } from './types.js';

type WatchCallback = (paths: string[]) => void;

// Registry: dirty set -> Set of callbacks
const watcherRegistry = new WeakMap<Set<string>, Set<WatchCallback>>();

/**
 * Internal: notify all watchers for a dirty set
 */
export function notifyWatchers(dirtySet: Set<string>): void {
  const watchers = watcherRegistry.get(dirtySet);
  if (!watchers || watchers.size === 0) return;

  const paths = [...dirtySet];
  for (const callback of watchers) {
    callback(paths);
  }
}

/**
 * Internal: register a watcher for a dirty set
 */
function registerWatcher(dirtySet: Set<string>, callback: WatchCallback): () => void {
  let watchers = watcherRegistry.get(dirtySet);
  if (!watchers) {
    watchers = new Set();
    watcherRegistry.set(dirtySet, watchers);
  }
  watchers.add(callback);

  // Return unsubscribe function
  return () => {
    watchers?.delete(callback);
  };
}

/**
 * Get the dirty set from an observable or model
 */
function getDirtySet<T extends object>(target: Observable<T> | Model<T>): Set<string> {
  if (OBSERVABLE_META in target) {
    return (target as Observable<T>)[OBSERVABLE_META].dirty;
  }
  if (MODEL_INTERNALS in target) {
    return (target as unknown as Model<T>)[MODEL_INTERNALS].dirty;
  }
  throw new Error('Target is not an observable or model');
}

export interface WatchHandle {
  unsubscribe: () => void;
}

export interface WatchAsyncIteratorOptions {
  /**
   * If true, coalesce multiple changes into one if consumer is slow.
   * Default: true
   */
  coalesce?: boolean;
}

export type Watcher = AsyncGenerator<string[], void, unknown> &
  Disposable &
  AsyncDisposable & {
    unsubscribe: () => void;
  };

/**
 * Watch an observable or model for changes.
 *
 * With callback: invokes callback with dirty paths on each change, returns { unsubscribe }
 * Without callback: returns async generator that yields dirty paths, with unsubscribe() method
 */
export function watch<T extends object>(
  target: Observable<T> | Model<T>,
  callback: (paths: string[]) => void,
): WatchHandle;
export function watch<T extends object>(
  target: Observable<T> | Model<T>,
  options?: WatchAsyncIteratorOptions,
): Watcher;
export function watch<T extends object>(
  target: Observable<T> | Model<T>,
  callbackOrOptions?: ((paths: string[]) => void) | WatchAsyncIteratorOptions,
): WatchHandle | Watcher {
  // Callback mode
  if (typeof callbackOrOptions === 'function') {
    const dirtySet = getDirtySet(target);
    const unsubscribe = registerWatcher(dirtySet, callbackOrOptions);
    return { unsubscribe };
  }

  // Async generator mode
  const options = callbackOrOptions ?? {};
  const { coalesce = true } = options;
  const dirtySet = getDirtySet(target);

  let pendingResolve: ((value: IteratorResult<string[], void>) => void) | null = null;
  let pendingPaths: string[] | null = null;
  let stopped = false;
  let unsubscribeFn: (() => void) | null = null;

  const callback: WatchCallback = (paths) => {
    if (stopped) return;

    if (pendingResolve) {
      // Consumer is waiting, resolve immediately
      pendingResolve({ value: paths, done: false });
      pendingResolve = null;
    } else if (coalesce) {
      // Not waiting, coalesce - just keep latest
      pendingPaths = paths;
    } else {
      pendingPaths = paths;
    }
  };

  unsubscribeFn = registerWatcher(dirtySet, callback);

  const doUnsubscribe = () => {
    stopped = true;
    if (unsubscribeFn) {
      unsubscribeFn();
      unsubscribeFn = null;
    }
    if (pendingResolve) {
      pendingResolve({ value: undefined, done: true });
      pendingResolve = null;
    }
  };

  const watcher: Watcher = {
    async next(): Promise<IteratorResult<string[], void>> {
      if (stopped) {
        return { value: undefined, done: true };
      }

      // If we have pending paths from while consumer was busy, return them
      if (pendingPaths !== null) {
        const paths = pendingPaths;
        pendingPaths = null;
        return { value: paths, done: false };
      }

      // Wait for next change
      return new Promise((resolve) => {
        pendingResolve = resolve;
      });
    },

    async return(): Promise<IteratorResult<string[], void>> {
      doUnsubscribe();
      return { value: undefined, done: true };
    },

    async throw(error: Error): Promise<IteratorResult<string[], void>> {
      doUnsubscribe();
      throw error;
    },

    unsubscribe: doUnsubscribe,

    [Symbol.asyncIterator]() {
      return this;
    },

    [Symbol.dispose]() {
      doUnsubscribe();
    },

    [Symbol.asyncDispose]() {
      doUnsubscribe();
      return Promise.resolve();
    },
  };

  return watcher;
}
