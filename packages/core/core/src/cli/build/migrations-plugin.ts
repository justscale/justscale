/**
 * esbuild plugin that resolves `@justscale/postgres/virtual/migrations`
 * to a generated module importing every `./migrations/*.ts` in the
 * project root. Each imported file's `defineMigration(...)` side-effects
 * into the module-level registry at boot, so `MigrationRunner` reads
 * from the registry — no runtime `readdir`, works in a bundled prod.
 *
 * The specifier looks like a package subpath but @justscale/postgres
 * doesn't actually ship a `virtual/migrations.js` file — this plugin
 * intercepts before Node resolution ever happens. Non-postgres apps
 * that never import the specifier pay zero cost.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'esbuild';

export interface MigrationsPluginOptions {
  /** Project root — plugin looks for `<rootDir>/migrations/*.ts`. */
  rootDir: string
  /** Migrations subdirectory relative to rootDir. Default: 'migrations'. */
  migrationsDir?: string
}

const VIRTUAL_SPECIFIER = '@justscale/postgres/virtual/migrations';
const VIRTUAL_NAMESPACE = 'justscale-migrations';

export function justscaleMigrationsPlugin(opts: MigrationsPluginOptions): Plugin {
  return {
    name: 'justscale-migrations',
    setup(build) {
      const migrationsDir = join(opts.rootDir, opts.migrationsDir ?? 'migrations');

      build.onResolve({ filter: new RegExp(`^${VIRTUAL_SPECIFIER.replace(/[/.]/g, '\\$&')}$`) }, (args) => ({
        path: args.path,
        namespace: VIRTUAL_NAMESPACE,
      }));

      build.onLoad({ filter: /.*/, namespace: VIRTUAL_NAMESPACE }, () => {
        if (!existsSync(migrationsDir)) {
          return { contents: '// No migrations/ directory found.', loader: 'js', resolveDir: opts.rootDir };
        }

        const files = readdirSync(migrationsDir)
          .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js')
          .sort();

        const contents = files
          .map((f) => `import '${join(migrationsDir, f).replace(/\\/g, '/')}';`)
          .join('\n') + '\n';

        return { contents, loader: 'ts', resolveDir: migrationsDir };
      });
    },
  };
}
