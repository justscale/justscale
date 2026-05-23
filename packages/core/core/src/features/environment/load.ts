import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ENVIRONMENT_TYPES, isEnvironment, type Environment, type EnvironmentType } from './types.js';

/**
 * Detect which environment should be active, in order of precedence:
 *
 * 1. `JUSTSCALE_ENV` env var (set by `just --env=<name>` or explicitly).
 * 2. If running under a test runner (detected via NODE_ENV=test or
 *    node:test module loaded), default to `'test'`.
 * 3. If `NODE_ENV=production`, default to `'production'`.
 * 4. Otherwise default to `'development'`.
 *
 * Returns the resolved environment NAME (not type - the name can be
 * anything the user's env files define; the type comes from the loaded
 * Environment object).
 */
export function detectEnvironmentName(): string {
  if (process.env.JUSTSCALE_ENV) {
    return process.env.JUSTSCALE_ENV;
  }
  if (process.env.NODE_ENV === 'test' || isTestRunnerDetected()) {
    return 'test';
  }
  if (process.env.NODE_ENV === 'production') {
    return 'production';
  }
  return 'development';
}

function isTestRunnerDetected(): boolean {
  // Vitest sets this global on its worker threads.
  return typeof (globalThis as { __VITEST_WORKER__?: unknown }).__VITEST_WORKER__ !== 'undefined';
}

// ============================================================================
// Static env registry (bundle-time injection)
// ============================================================================

/**
 * Environments registered at bundle time by `just build --env <name>`.
 * Allows bundled deploy artifacts to skip filesystem lookup.
 * @internal
 */
const STATIC_ENVS = new Map<string, Environment>();

export function __registerStaticEnvironment(name: string, env: Environment): void {
  STATIC_ENVS.set(name, env);
}

export interface LoadEnvironmentOptions {
  /**
   * Anchor for resolving `env/`. Pass `import.meta` so the loader walks up
   * from the caller's file to the nearest `package.json` and looks for an
   * `env/` directory there. This is the recommended form - it makes the
   * env resolution independent of `process.cwd()`, which is the workspace
   * root when run via `just run`.
   */
  from?: ImportMeta | { url: string }
  /**
   * Directory containing env/*.ts files. Takes precedence over `from`.
   * Falls back to `process.cwd()/env` if neither is provided.
   */
  envDir?: string
  /**
   * Override the detected environment name.
   */
  name?: string
  /**
   * File extensions to try, in order. Defaults to `['.ts', '.js', '.mjs']`.
   */
  extensions?: readonly string[]
}

/**
 * Walk up from `startDir` until a `package.json` is found. Returns the
 * directory containing it, or `null` if no package.json is found.
 */
function findPackageRoot(startDir: string): string | null {
  let dir = startDir;
  // Prevent infinite loops on malformed paths.
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Given an ImportMeta-like anchor, return `{packageRoot}/env`.
 * Walks up from the anchor's file URL to the nearest package.json.
 */
function resolveEnvDirFromAnchor(anchor: { url: string }): string {
  const filePath = fileURLToPath(anchor.url);
  const pkgRoot = findPackageRoot(dirname(filePath));
  if (!pkgRoot) {
    throw new Error(
      `loadEnvironment: could not find a package.json above '${filePath}'. ` +
      'Pass { envDir } explicitly instead of { from }.',
    );
  }
  return join(pkgRoot, 'env');
}

/**
 * Load the active environment by dynamic-importing `{envDir}/{name}.{ext}`.
 *
 * @example
 * ```typescript
 * const env = await loadEnvironment({ from: import.meta })
 * const app = JustScale().add(env).add(MyFeature).build()
 * ```
 *
 * @throws if the resolved env file cannot be found or does not export an Environment.
 */
export async function loadEnvironment<E extends Environment = Environment>(
  options: LoadEnvironmentOptions = {},
): Promise<E> {
  const name = options.name ?? detectEnvironmentName();

  if (!options.envDir) {
    const staticEnv = STATIC_ENVS.get(name);
    if (staticEnv) return staticEnv as E;
  }

  const envDir = options.envDir
    ?? (options.from ? resolveEnvDirFromAnchor(options.from) : join(process.cwd(), 'env'));
  const extensions = options.extensions ?? ['.ts', '.js', '.mjs'];

  const candidates = extensions.map((ext) => join(envDir, `${name}${ext}`));
  const match = candidates.find((path) => existsSync(path));

  if (!match) {
    throw new Error(
      `loadEnvironment: no env file found for '${name}'. Looked in: ${candidates.join(', ')}. ` +
      'Set $JUSTSCALE_ENV or pass { name } to select a different environment, or create the file.',
    );
  }

  const module = await import(pathToFileURL(match).href) as { default?: unknown };
  const value = module.default;

  if (!isEnvironment(value)) {
    throw new Error(
      `loadEnvironment: '${match}' must export default createEnvironment({...}) - got ${typeof value}`,
    );
  }

  return value as E;
}

/**
 * Whitelist guard for environment type names. Useful for code that wants
 * to validate an arbitrary string is a known EnvironmentType.
 */
export function isEnvironmentType(value: string): value is EnvironmentType {
  return (ENVIRONMENT_TYPES as readonly string[]).includes(value);
}
