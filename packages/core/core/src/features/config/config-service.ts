/**
 * ConfigService - Runtime mutations and persistence
 *
 * Provides:
 * - Runtime config mutations (CLI `config set`)
 * - Persistence to `.justscale/config.json`
 * - Watching for changes via async iterables
 */

import { defineService, type Resolver } from '../../core/index.js';
import type { ConfigPartial } from './types.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ============================================================================
// ConfigService Interface
// ============================================================================

export interface ConfigService {
  /**
   * Update a config value at runtime.
   * - Updates in-memory state in the container
   * - Persists to .justscale/config.json
   * - Notifies all watchers
   *
   * @returns Number of watchers notified
   */
  set<T>(partial: ConfigPartial<T>, path: string, value: unknown): Promise<number>

  /**
   * Watch for config changes via async iterable.
   *
   * @example
   * ```typescript
   * for await (const [oldConfig, newConfig] of configService.watch(PgConfig)) {
   *   console.log('Config changed:', oldConfig, '→', newConfig)
   * }
   * ```
   */
  watch<T>(partial: ConfigPartial<T>, path?: string): AsyncIterable<[T, T]>
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Set a value at a nested path in an object.
 * Creates a shallow copy at each level.
 */
function setPath(obj: any, path: string, value: unknown): any {
  const result = { ...obj };
  const keys = path.split('.');
  let current = result;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    current[key] = { ...current[key] };
    current = current[key];
  }

  current[keys[keys.length - 1]] = value;
  return result;
}

/**
 * Get a value at a nested path in an object.
 */
function getPath(obj: any, path: string): unknown {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
}

// ============================================================================
// Options
// ============================================================================

export interface ConfigServiceOptions {
  /** Custom config directory path. Defaults to `${cwd}/.justscale` */
  configDir?: string
}

// ============================================================================
// Implementation
// ============================================================================

type WatcherCallback = (oldValue: unknown, newValue: unknown) => void;

class ConfigServiceImpl implements ConfigService {
  /** Watchers per partial (by symbol key) */
  private watchers = new Map<symbol, Set<WatcherCallback>>();

  /** Config directory path */
  private readonly configDir: string;

  /** Config file path */
  private readonly configPath: string;

  constructor(
    private readonly resolver: Resolver,
    options?: ConfigServiceOptions
  ) {
    this.configDir = options?.configDir ?? join(process.cwd(), '.justscale');
    this.configPath = join(this.configDir, 'config.json');
  }

  /**
   * Load persisted config from disk.
   */
  private loadPersistedConfig(): Record<string, unknown> {
    if (!existsSync(this.configPath)) return {};
    try {
      return JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  /**
   * Save config to disk.
   */
  private persistConfig(partialName: string, value: unknown): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }

    const existing = this.loadPersistedConfig();
    existing[partialName] = value;
    writeFileSync(this.configPath, JSON.stringify(existing, null, 2));
  }

  async set<T>(partial: ConfigPartial<T>, path: string, value: unknown): Promise<number> {
    // Get current value from container using the partial's symbol key
    // The resolver can resolve any token, including raw symbols
    const oldValue = await this.resolver<T>(partial.key as any);

    // Create new value with the path updated
    const newValue = setPath(oldValue, path, value);

    // Validate against schema
    partial.schema.parse(newValue);

    // Update container so subsequent resolves return the new value
    this.resolver.registerInstance!(partial.key as any, newValue);

    // Persist to disk
    this.persistConfig(partial.name, newValue);

    const callbacks = this.watchers.get(partial.key) ?? new Set();
    for (const cb of callbacks) {
      try {
        cb(oldValue, newValue);
      } catch {
        callbacks.delete(cb);
      }
    }

    return callbacks.size;
  }

  watch<T>(partial: ConfigPartial<T>, path?: string): AsyncIterable<[T, T]> {
    const watchers = this.watchers;
    const partialKey = partial.key;

    return {
      [Symbol.asyncIterator]() {
        const queue: Array<[T, T]> = [];
        let resolve: ((value: IteratorResult<[T, T]>) => void) | null = null;
        let done = false;

        const callback: WatcherCallback = (oldVal: unknown, newVal: unknown) => {
          if (done) return;

          // If watching a specific path, check if it changed
          if (path) {
            const oldPath = getPath(oldVal, path);
            const newPath = getPath(newVal, path);
            if (oldPath === newPath) return;
          }

          const pair: [T, T] = [oldVal as T, newVal as T];

          if (resolve) {
            resolve({ value: pair, done: false });
            resolve = null;
          } else {
            queue.push(pair);
          }
        };

        // Register watcher
        if (!watchers.has(partialKey)) {
          watchers.set(partialKey, new Set());
        }
        watchers.get(partialKey)!.add(callback);

        return {
          async next(): Promise<IteratorResult<[T, T]>> {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false };
            }
            if (done) {
              return { value: undefined as any, done: true };
            }
            return new Promise(r => { resolve = r; });
          },

          async return(): Promise<IteratorResult<[T, T]>> {
            done = true;
            watchers.get(partialKey)?.delete(callback);
            return { value: undefined as any, done: true };
          },

          async throw(e: Error): Promise<IteratorResult<[T, T]>> {
            done = true;
            watchers.get(partialKey)?.delete(callback);
            throw e;
          },
        };
      }
    };
  }
}

// ============================================================================
// Service Definition
// ============================================================================

/** ConfigService DI token. */
export class ConfigServiceDef extends defineService({
  inject: {},
  factory: (_deps, resolver): ConfigService => new ConfigServiceImpl(resolver),
}) {}

/**
 * Create a ConfigService instance with custom options.
 * Useful for testing with isolated config directories.
 *
 * @example
 * ```typescript
 * const configService = createConfigService(resolver, {
 *   configDir: '/tmp/my-test-config'
 * })
 * ```
 */
export function createConfigService(
  resolver: Resolver,
  options?: ConfigServiceOptions
): ConfigService {
  return new ConfigServiceImpl(resolver, options);
}
