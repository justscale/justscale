/**
 * Dev server — runs the user's app entry with file watching and auto
 * restart. Skips an explicit build step: tsx transforms TS on the fly,
 * and `tsx watch` handles restart-on-change natively. In production
 * users ship compiled JS via `just build` and run `node dist/app.js`.
 *
 * Entry selection mirrors `assembleCliApp`: load `justscale.config.ts`,
 * resolve the active env, look up `config.app[env.type]` (falling back
 * to `config.app.default`), and extract the file path from the loader.
 * This way `just dev` in a `type: 'development'` env picks up `dev.ts`
 * instead of `app.ts`, so pglite / in-memory channel overrides are
 * hot-reloaded alongside the user's composition.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { loadEnvironment } from '../features/environment/load.js';
import { discover } from './discovery.js';
import { extractLoaderPath, pickAppLoader, resolveAppEntry } from './define-project.js';

function findBinDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = start;
  while (true) {
    const candidate = join(current, 'node_modules', '.bin');
    if (existsSync(candidate)) dirs.push(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

interface DevServerOptions {
  root: string
  log: (msg: string) => void
}

/**
 * Is `@justscale/hmr/register` resolvable from the project? `just dev` enables
 * hot reload by adding it to the child's `--import` chain. It is an OPTIONAL,
 * dev-only peer: @justscale/core deliberately does NOT depend on it (the core
 * stays dependency-free). So we probe for it at runtime rather than assuming
 * it's there — and if it's missing, tell the user how to add it instead of
 * letting Node die with a raw ERR_MODULE_NOT_FOUND.
 */
function hmrInstalled(root: string): boolean {
  try {
    createRequire(join(root, 'package.json')).resolve('@justscale/hmr/register');
    return true;
  } catch {
    return false;
  }
}

/** Best-effort install command matching the project's package manager. */
function hmrInstallHint(root: string): string {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm add -D @justscale/hmr';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn add -D @justscale/hmr';
  return 'npm install -D @justscale/hmr';
}

/**
 * Legacy fallback: locate the app entry via conventional filenames.
 * Used only when `justscale.config.ts` is absent or the loader path
 * couldn't be extracted.
 */
function findServeEntry(root: string): string | null {
  const candidates = ['src/app.ts', 'src/main.ts', 'src/server.ts', 'src/serve.ts'];
  for (const candidate of candidates) {
    const fullPath = join(root, candidate);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

async function pickEntry(
  root: string,
  log: (msg: string) => void,
): Promise<string | null> {
  const result = await discover();
  if (!result || !result.config.app) {
    log('[dev] No justscale.config.ts or config.app; falling back to filename search.');
    return findServeEntry(root);
  }

  const env = await loadEnvironment({ from: { url: result.configFileUrl } });
  const loader = pickAppLoader(result.config.app, env.type);
  const loaderPath = extractLoaderPath(loader);
  if (!loaderPath) {
    log(
      `[dev] Could not extract an import path from config.app for env.type='${env.type}'. ` +
      'Loader is not a simple `() => import(\'./src/xyz.js\')`. ' +
      'Falling back to filename search.',
    );
    return findServeEntry(root);
  }

  const resolved = resolveAppEntry(result.configFileUrl, result.config.app, env.type);
  if (!resolved) {
    log(`[dev] config.app[${env.type}] points at '${loaderPath}', but neither that file nor its .ts variant exists.`);
    return findServeEntry(root);
  }
  log(`[dev] env.type='${env.type}' → ${resolved}`);
  return resolved;
}

export async function startDevServer(options: DevServerOptions): Promise<void> {
  const { root, log } = options;

  const entry = await pickEntry(root, log);
  if (!entry) {
    log(
      '[dev] No app entry found. Expected a justscale.config.ts with an `app` entry, ' +
      'or one of src/app.ts, src/main.ts, src/server.ts, src/serve.ts.',
    );
    process.exit(1);
  }

  // Hot reload is the whole point of `just dev`, and it rides on
  // `@justscale/hmr`. Since the core can't depend on it, make sure the project
  // does — otherwise the spawn below fails with a cryptic ERR_MODULE_NOT_FOUND.
  if (!hmrInstalled(root)) {
    log(
      '[dev] Hot reload needs @justscale/hmr, but it is not installed.\n' +
      `      Add it (dev dependency):  ${hmrInstallHint(root)}\n` +
      '      then re-run `just dev`.',
    );
    process.exit(1);
  }

  log(`[dev] Starting ${entry}`);

  // No `tsx watch` — the kernel starts an in-process HMR file watcher
  // when NODE_ENV=development, which re-imports changed modules and
  // calls `container.hotReload()` without restarting the process.
  // That keeps pglite state, the HTTP listen socket, and lifecycle
  // instances alive across edits.
  //
  // Loader chain: `@justscale/typescript/register` handles process +
  // proto compilation; `tsx` handles the rest of the TS -> JS transform.
  //
  // PATH prepending is required so `tsx` resolves — Node's `spawn` uses
  // the child's PATH (not the interactive shell's), so the project's
  // node_modules/.bin must be made visible explicitly.
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathPrefix = findBinDirs(root).join(sep);
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PATH: pathPrefix
      ? `${pathPrefix}${sep}${process.env.PATH ?? ''}`
      : (process.env.PATH ?? ''),
  };
  // The `@justscale/hmr/register` observer loader records every file
  // URL the process loads. The in-process HMR watcher (started by the
  // kernel when NODE_ENV=development) reads that set to decide which
  // directories to watch and which service tokens to swap on change.
  const proc: ChildProcess = spawn(
    'node',
    [
      '--import',
      '@justscale/typescript/register',
      '--import',
      '@justscale/hmr/register',
      '--import',
      'tsx',
      entry,
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env,
    },
  );

  const cleanup = () => {
    if (!proc.killed) proc.kill('SIGTERM');
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  await new Promise<void>((resolve) => {
    proc.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}
