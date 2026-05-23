/**
 * Virtual migration loader - `import '@justscale/postgres/virtual/migrations'`.
 *
 * Dual-mode:
 *   - **Bundled prod**: the esbuild plugin (`justscaleMigrationsPlugin`)
 *     resolves this specifier BEFORE Node resolution, replacing the
 *     module contents with static `import` lines for every migration
 *     file at build time. This file is never reached.
 *   - **Dev / unbundled**: Node resolves this file. Top-level `await`
 *     reads the project's `./migrations/` directory and dynamically
 *     imports each entry - every `defineMigration(...)` call fires as
 *     a side effect, populating the runtime registry.
 *
 * Convention: `./migrations/` relative to `process.cwd()`. `just dev`
 * and `just migrate run` both run from the project root, so this
 * holds without additional plumbing.
 */

import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

let entries: string[];
try {
  entries = await readdir(MIGRATIONS_DIR);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    // No migrations directory - silently skip. Apps without migrations
    // still benefit from being able to `import` this specifier.
    entries = [];
  } else {
    throw err;
  }
}

const migrationFiles = entries
  .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js')
  .sort();

for (const file of migrationFiles) {
  await import(pathToFileURL(join(MIGRATIONS_DIR, file)).href);
}
