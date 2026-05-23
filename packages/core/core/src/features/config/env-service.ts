/**
 * Environment Variable Service
 *
 * Provides typed access to environment variables with validation and parsing.
 */

import { defineService } from '../../core/index.js';
import { watchEnvFiles, type EnvFileWatcher } from './file-watcher.js';

/**
 * Service for typed environment variable access.
 */
export interface EnvService {
  /**
   * Get string value from env
   */
  string(key: string, defaultValue?: string): string

  /**
   * Get number value from env.
   *
   * Uses `Number(raw)` + `Number.isFinite` so values like '3.7' remain 3.7
   * (not silently truncated to 3) and partial numerics like '100px' throw
   * instead of returning 100. Throws when the value is missing and no
   * default is supplied.
   */
  number(key: string, defaultValue?: number): number

  /**
   * Get boolean value from env
   * Truthy: 'true', '1', 'yes', 'on'
   * Falsy: 'false', '0', 'no', 'off', undefined
   */
  boolean(key: string, defaultValue?: boolean): boolean

  /**
   * Get JSON-parsed value from env
   */
  json<T>(key: string, defaultValue?: T): T

  /**
   * Check if an env key exists
   */
  has(key: string): boolean

  /**
   * Get raw value (no parsing)
   */
  raw(key: string): string | undefined

  /**
   * Watch an env key for changes (via file watcher)
   * Only works with file-backed env (.env files)
   */
  watch(key: string): {
    subscribe: (callback: (value: string | undefined) => void) => () => void
  }
}

// ============================================================================
// Implementation
// ============================================================================

class EnvServiceImpl implements EnvService {
  private fileWatcher: EnvFileWatcher | null = null;

  raw(key: string): string | undefined {
    return process.env[key];
  }

  has(key: string): boolean {
    const v = process.env[key];
    return typeof v === 'string' && v.length > 0;
  }

  string(key: string, defaultValue?: string): string {
    const value = this.raw(key);

    if (value === undefined) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Required environment variable "${key}" is not set`);
    }

    return value;
  }

  number(key: string, defaultValue?: number): number {
    const value = this.raw(key);

    if (value === undefined) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Required environment variable "${key}" is not set`);
    }

    if (value === '') {
      throw new Error(
        `EnvService.number('${key}'): value '' is not a valid number`
      );
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
      throw new Error(
        `EnvService.number('${key}'): value '${value}' is not a valid number`
      );
    }

    return parsed;
  }

  boolean(key: string, defaultValue?: boolean): boolean {
    const value = this.raw(key);

    if (value === undefined) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      return false;
    }

    const lower = value.toLowerCase();

    // Truthy values
    if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') {
      return true;
    }

    // Falsy values
    if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') {
      return false;
    }

    throw new Error(
      `Environment variable "${key}" has invalid boolean value: "${value}". ` +
      'Expected one of: true, false, 1, 0, yes, no, on, off'
    );
  }

  json<T>(key: string, defaultValue?: T): T {
    const value = this.raw(key);

    if (value === undefined) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Required environment variable "${key}" is not set`);
    }

    try {
      return JSON.parse(value) as T;
    } catch (error) {
      throw new Error(
        `Environment variable "${key}" has invalid JSON value: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  watch(key: string): {
    subscribe: (callback: (value: string | undefined) => void) => () => void
  } {
    // Lazy-init file watcher
    if (!this.fileWatcher) {
      // Common .env file locations
      const envPaths = [
        process.cwd() + '/.env',
        process.cwd() + '/.env.local',
      ];
      this.fileWatcher = watchEnvFiles(envPaths);
    }

    const watcher = this.fileWatcher;

    return {
      subscribe: (callback: (value: string | undefined) => void) => {
        // Call immediately with current value
        callback(watcher.values[key]);

        // Subscribe to changes
        const unsubscribe = watcher.subscribe((values) => {
          callback(values[key]);
        });

        return unsubscribe;
      },
    };
  }
}

// ============================================================================
// Service Definition
// ============================================================================

/** EnvService DI token. */
export class EnvServiceDef extends defineService({
  inject: {},
  factory: (): EnvService => new EnvServiceImpl(),
}) {}
