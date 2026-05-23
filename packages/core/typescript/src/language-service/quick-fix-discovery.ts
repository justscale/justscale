/**
 * Quick Fix Discovery
 *
 * Scans installed packages for "justscale" field with "quickFixes" entry,
 * imports the quick fix modules, and registers them with the language service.
 *
 * Watches the lockfile for changes to detect new packages.
 */

import { existsSync, readFileSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';

/**
 * Quick fix definition contributed by packages.
 *
 * Uses `any` for TS types to avoid cross-version type conflicts
 * between the compiler package (TS 5.x) and user packages (TS 6.x).
 * At runtime, the actual TS instance is passed in - types are loose but safe.
 */
export interface QuickFixDefinition {
  id: string
  when: (node: any, checker: any, tsLib: any) => boolean
  label: string
  fix: (node: any, checker: any, tsLib: any) => { fileName: string; textChanges: { span: { start: number; length: number }; newText: string }[] }[]
}

/**
 * Discover quick fix modules from installed packages.
 */
export async function discoverQuickFixes(projectRoot: string, log: (msg: string) => void): Promise<QuickFixDefinition[]> {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return [];
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const quickFixes: QuickFixDefinition[] = [];

  for (const depName of Object.keys(deps)) {
    try {
      const depPkgPath = resolveDepPackageJson(projectRoot, depName);
      if (!depPkgPath) continue;

      const depPkg = JSON.parse(readFileSync(depPkgPath, 'utf-8'));
      const justscaleField = depPkg.justscale;
      if (!justscaleField?.quickFixes) continue;

      const qfConfig = justscaleField.quickFixes;
      const modulePath = resolveModulePath(depPkgPath, qfConfig);
      if (!modulePath) continue;

      const qfModule = await import(modulePath);

      // Collect exported quick fix definitions
      for (const value of Object.values(qfModule)) {
        if (isQuickFixDefinition(value)) {
          quickFixes.push(value as QuickFixDefinition);
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (isQuickFixDefinition(item)) {
              quickFixes.push(item as QuickFixDefinition);
            }
          }
        }
      }

      log(`Loaded ${quickFixes.length} quick fix(es) from ${depName}`);
    } catch (err) {
      log(`Warning: failed to load quick fixes from ${depName}: ${(err as Error).message}`);
    }
  }

  return quickFixes;
}

/**
 * Watch lockfile for changes and re-discover quick fixes.
 */
export function watchLockfile(
  projectRoot: string,
  onChange: () => void,
  log: (msg: string) => void,
): () => void {
  const lockfiles = [
    join(projectRoot, 'pnpm-lock.yaml'),
    join(projectRoot, 'package-lock.json'),
    join(projectRoot, 'yarn.lock'),
  ];

  const watchers: string[] = [];

  for (const lockfile of lockfiles) {
    if (existsSync(lockfile)) {
      watchFile(lockfile, { interval: 2000 }, () => {
        log(`Lockfile changed: ${lockfile}`);
        onChange();
      });
      watchers.push(lockfile);
      log(`Watching lockfile: ${lockfile}`);
    }
  }

  return () => {
    for (const lockfile of watchers) {
      unwatchFile(lockfile);
    }
  };
}

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

function resolveModulePath(depPkgPath: string, config: { source?: string; import?: string }): string | null {
  const depDir = join(depPkgPath, '..');

  if (config.import) {
    const importPath = join(depDir, config.import);
    if (existsSync(importPath)) return importPath;
  }

  if (config.source) {
    const sourcePath = join(depDir, config.source);
    if (existsSync(sourcePath)) return sourcePath;
  }

  return null;
}

function isQuickFixDefinition(value: unknown): value is QuickFixDefinition {
  if (!value || typeof value !== 'object') return false;
  const obj = value as any;
  return typeof obj.id === 'string' &&
    typeof obj.when === 'function' &&
    typeof obj.label === 'string' &&
    typeof obj.fix === 'function';
}
