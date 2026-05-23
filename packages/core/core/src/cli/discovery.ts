/**
 * Discovery module — finds project config and package-contributed CLI controllers.
 *
 * Used by:
 * - main.ts (CLI entry point)
 * - mcp serve command
 * - any future consumer that needs to discover the project structure
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ProjectConfig, isProjectConfig } from './define-project.js';

// ============================================================================
// Types
// ============================================================================

export interface ProjectDiscoveryResult {
  type: 'project'
  config: ProjectConfig
  /** file:// URL of the loaded justscale.config.{ts,js} — used as the
   * anchor for `loadEnvironment({ from })` so env resolution starts
   * from the project root, not the (possibly workspace-level) cwd. */
  configFileUrl: string
}

export type DiscoveryResult = ProjectDiscoveryResult | null;

// ============================================================================
// Project Discovery
// ============================================================================

const PROJECT_CONFIG_PATHS = [
  'justscale.config.ts',
  'justscale.config.js',
];

/**
 * Discover a `justscale.config.ts` (defineProject result) in the current
 * directory. Returns `null` if no config is present — callers fall back to
 * built-in-only behaviour in that case.
 */
export async function discover(): Promise<DiscoveryResult> {
  const cwd = process.cwd();

  for (const relativePath of PROJECT_CONFIG_PATHS) {
    const fullPath = join(cwd, relativePath);
    if (!existsSync(fullPath)) continue;

    try {
      const fileUrl = pathToFileURL(fullPath).href;
      const module = await import(fileUrl);
      if (module.default && isProjectConfig(module.default)) {
        return { type: 'project', config: module.default, configFileUrl: fileUrl };
      }
    } catch (err) {
      console.error(`Error loading ${relativePath}:`, (err as Error).message);
    }
  }

  return null;
}

// ============================================================================
// Package Command Discovery
// ============================================================================

/**
 * Discover CLI controllers from dependencies that have a "justscale" field.
 */
export async function discoverPackageCommands(): Promise<any[]> {
  const cwd = process.cwd();
  const pkgPath = join(cwd, 'package.json');

  if (!existsSync(pkgPath)) return [];

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return [];
  }

  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  const controllers: any[] = [];

  for (const depName of Object.keys(deps)) {
    try {
      const depPkgPath = resolveDepPackageJson(cwd, depName);
      if (!depPkgPath) continue;

      const depPkg = JSON.parse(readFileSync(depPkgPath, 'utf-8'));
      const justscaleField = depPkg.justscale;
      if (!justscaleField?.modes?.cli) continue;

      const cliConfig = justscaleField.modes.cli;
      const modulePath = resolveModulePath(depPkgPath, cliConfig);
      if (!modulePath) continue;

      const cliModule = await import(pathToFileURL(modulePath).href);

      for (const exportValue of Object.values(cliModule)) {
        if (isControllerExport(exportValue)) {
          controllers.push(exportValue);
        }
      }
    } catch (err) {
      console.error(`Warning: failed to load CLI commands from ${depName}:`, (err as Error).message);
    }
  }

  return controllers;
}

/**
 * Find a dependency's package.json in node_modules.
 * Walks up the directory tree to handle hoisted deps in monorepos.
 */
function resolveDepPackageJson(cwd: string, depName: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, 'node_modules', depName, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the CLI module path from the justscale.modes.cli config.
 *
 * Prefers "import" (built JS) over "source" (TS) because the just binary
 * runs compiled code — importing .ts files requires a loader (tsx) which
 * may not be registered. Built .js files always work.
 */
function resolveModulePath(
  depPkgPath: string,
  config: { source?: string; import?: string },
): string | null {
  const depDir = join(depPkgPath, '..');

  // Prefer import (built JS — always works)
  if (config.import) {
    const importPath = join(depDir, config.import);
    if (existsSync(importPath)) return importPath;
  }

  // Fall back to source (TS — requires tsx/ts-node loader)
  if (config.source) {
    const sourcePath = join(depDir, config.source);
    if (existsSync(sourcePath)) return sourcePath;
  }

  return null;
}

/**
 * Check if a value looks like a controller definition (from createController).
 */
function isControllerExport(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as any;
  return typeof obj.factory === 'function' && 'deps' in obj;
}
