/**
 * Project configuration for the `just` CLI.
 *
 * Declares one app entry (optionally split by env.type), build settings,
 * and environment configuration. Used in `justscale.config.ts`.
 *
 * @example Shorthand — one composition for every env
 * ```typescript
 * export default defineProject({
 *   app: () => import('./src/app.js'),
 * })
 * ```
 *
 * @example Split by env.type — dev.ts adds pglite + dev CLIs
 * ```typescript
 * export default defineProject({
 *   app: {
 *     default:     () => import('./src/app.js'),
 *     development: () => import('./src/dev.js'),
 *     test:        () => import('./src/dev.js'),
 *   },
 * })
 * ```
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvironmentType } from '../features/environment/types.js';

export interface EnvironmentConfig {
  url: string
  ssh?: string
}

export interface BuildConfig {
  outDir?: string
  target?: string
  /**
   * Files or globs to copy into the output directory alongside the bundled
   * entry when running `just build --env <name>`. Useful for artifacts the
   * deployed process needs at runtime but that don't live in the bundle
   * (SQL migration files, OpenAPI specs, etc.). Paths are resolved relative
   * to the directory containing `justscale.config.ts`.
   */
  include?: string[]
  /**
   * Package specifiers to keep external (not bundled). Node builtins
   * (`node:*`) are handled automatically. Use this for native modules
   * with `.node` binaries (better-sqlite3, bcrypt, sharp, canvas) or
   * any package that doesn't survive bundling. Anything not in this
   * list is inlined into the output — that's what gives the deploy
   * artifact real tree-shaking benefit.
   */
  external?: string[]
}

/** Lazy import factory returning the user's app module. */
export type AppLoader = () => Promise<unknown>;

/**
 * User-configurable app entry. Either a single loader (same composition
 * for every env), or an object with a required `default` fallback and
 * optional per-env overrides keyed by `env.type`.
 */
export type AppEntry =
  | AppLoader
  | ({ default: AppLoader } & Partial<Record<EnvironmentType, AppLoader>>);

export interface ProjectConfig {
  app: AppEntry
  build?: BuildConfig
  environments?: Record<string, EnvironmentConfig>
}

/**
 * Resolve the loader for a given env.type. Function-shorthand entries
 * are returned as-is; object-form entries prefer the type-specific
 * override and fall through to `default`.
 */
export function pickAppLoader(
  app: AppEntry,
  envType: EnvironmentType,
): AppLoader {
  if (typeof app === 'function') return app;
  return app[envType] ?? app.default;
}

const PROJECT_CONFIG_SYMBOL = Symbol('justscale.project-config');

export function defineProject(config: ProjectConfig): ProjectConfig {
  return Object.assign(config, { [PROJECT_CONFIG_SYMBOL]: true });
}

export function isProjectConfig(value: unknown): value is ProjectConfig {
  return typeof value === 'object' && value !== null && PROJECT_CONFIG_SYMBOL in value;
}

/**
 * Extract the file path argument from a lazy import loader like
 * `() => import('./src/dev.js')`. Returns null if the loader uses a shape
 * we can't introspect (computed specifiers, re-exports, dynamic paths).
 * Shared by `just dev` and `just build` so both resolve the app entry the
 * same way.
 */
export function extractLoaderPath(loader: AppLoader): string | null {
  const src = loader.toString();
  const match = src.match(/import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);
  return match?.[1] ?? null;
}

/**
 * `config.app` uses `.js` suffixes even when the source is `.ts` (NodeNext
 * resolution convention). Resolve to the actual source file that exists on
 * disk, preferring the `.ts` variant when it's alongside the `.js` path.
 */
export function resolveSourcePath(baseDir: string, loaderPath: string): string | null {
  const absolute = resolve(baseDir, loaderPath);
  if (existsSync(absolute)) return absolute;
  if (absolute.endsWith('.js')) {
    const tsVariant = absolute.slice(0, -3) + '.ts';
    if (existsSync(tsVariant)) return tsVariant;
  }
  return null;
}

/**
 * Resolve the app entry source file for a given env.type. Returns null if
 * the config doesn't point at a file the filesystem can produce.
 */
export function resolveAppEntry(
  configFileUrl: string,
  app: AppEntry,
  envType: EnvironmentType,
): string | null {
  const loader = pickAppLoader(app, envType);
  const loaderPath = extractLoaderPath(loader);
  if (!loaderPath) return null;
  const configDir = dirname(fileURLToPath(configFileUrl));
  return resolveSourcePath(configDir, loaderPath);
}
