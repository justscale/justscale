import { defineService, type Resolver } from '../../core/index.js';
import type { FeatureFlagPartial } from './types.js';

type WatcherCallback = (oldValue: unknown, newValue: unknown) => void;

/**
 * Structural equality for flag values (plain JSON-ish shapes from providers).
 * Cheap enough for the update() hot path; objects are small and shallow.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * Feature flag access with reactive updates.
 *
 * - `.read(partial)` - current value.
 * - `.update(partial, value)` - push a new value (used by external flag
 *   adapters when the upstream source changes).
 * - `.watch(partial)` - async-iterable of [old, new] pairs.
 *
 * No disk persistence - runtime-only. Providers supply initial values at
 * boot; adapters call `.update()` to push subsequent changes.
 */
export interface FeatureFlagService {
  read<T>(partial: FeatureFlagPartial<T>): Promise<T>
  update<T>(partial: FeatureFlagPartial<T>, value: T): Promise<number>
  watch<T>(partial: FeatureFlagPartial<T>): AsyncIterable<[T, T]>
}

class FeatureFlagServiceImpl implements FeatureFlagService {
  private watchers = new Map<symbol, Set<WatcherCallback>>();

  constructor(private readonly resolver: Resolver) {}

  async read<T>(partial: FeatureFlagPartial<T>): Promise<T> {
    const value = await this.resolver<T>(partial.key as any);
    if (value === undefined) {
      throw new Error(
        `FeatureFlagService.read: no provider registered a value for feature-flag partial '${partial.name}'.`,
      );
    }
    return value;
  }

  async update<T>(partial: FeatureFlagPartial<T>, value: T): Promise<number> {
    partial.schema.parse(value);
    const oldValue = await this.resolver<T>(partial.key as any).catch(() => undefined);

    // Skip the notify loop when nothing actually changed. External
    // adapters (LaunchDarkly, Unleash) poll and call update() on every
    // tick; without this every watcher wakes for no reason.
    if (oldValue !== undefined && deepEqual(oldValue, value)) {
      return 0;
    }

    this.resolver.registerInstance!(partial.key as any, value);

    const callbacks = this.watchers.get(partial.key) ?? new Set();
    let notified = 0;
    for (const cb of callbacks) {
      try {
        cb(oldValue, value);
        notified++;
      } catch (err) {
        // Don't silently unsubscribe - a buggy callback shouldn't drop
        // the watcher. Log and continue; callers remove via `return()`.
         
        console.error('[FeatureFlagService] watcher threw, continuing:', err);
      }
    }
    return notified;
  }

  watch<T>(partial: FeatureFlagPartial<T>): AsyncIterable<[T, T]> {
    const watchers = this.watchers;
    const key = partial.key;

    return {
      [Symbol.asyncIterator]() {
        const queue: Array<[T, T]> = [];
        let pending: ((v: IteratorResult<[T, T]>) => void) | null = null;
        let done = false;

        const cb: WatcherCallback = (oldVal, newVal) => {
          if (done) return;
          const pair: [T, T] = [oldVal as T, newVal as T];
          if (pending) {
            pending({ value: pair, done: false });
            pending = null;
          } else {
            queue.push(pair);
          }
        };

        if (!watchers.has(key)) watchers.set(key, new Set());
        watchers.get(key)!.add(cb);

        return {
          async next(): Promise<IteratorResult<[T, T]>> {
            if (queue.length) return { value: queue.shift()!, done: false };
            if (done) return { value: undefined as any, done: true };
            return new Promise((r) => { pending = r; });
          },
          async return(): Promise<IteratorResult<[T, T]>> {
            done = true;
            watchers.get(key)?.delete(cb);
            return { value: undefined as any, done: true };
          },
          async throw(e: Error): Promise<IteratorResult<[T, T]>> {
            done = true;
            watchers.get(key)?.delete(cb);
            throw e;
          },
        };
      },
    };
  }
}

export class FeatureFlagServiceDef extends defineService({
  inject: {},
  factory: (_deps, resolver): FeatureFlagService => new FeatureFlagServiceImpl(resolver),
}) {}
