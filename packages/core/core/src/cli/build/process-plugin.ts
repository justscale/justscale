/**
 * esbuild plugin that routes `.process.ts` files (and `.ts` files that
 * contain `createProcess` against `@justscale/core/process`) through the
 * JustScale process compiler before esbuild bundles them. Non-process
 * TypeScript is left alone — esbuild's built-in TS support handles it.
 *
 * The plugin relies on `PtsCompiler` producing an inline base64 source
 * map; esbuild auto-detects that and folds it into the final bundle's
 * map when the build is configured with `sourcemap: true`.
 *
 * `@justscale/typescript` is loaded dynamically so apps that don't use
 * process features (or don't build via `just build --env`) aren't forced
 * to pull the TypeScript compiler into their dep tree.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Plugin } from 'esbuild';

function looksLikeProcessFile(filePath: string, source: string): boolean {
  if (basename(filePath).includes('.process.')) return true;
  return (
    source.includes('@justscale/core/process') &&
    source.includes('createProcess')
  );
}

export interface ProcessPluginOptions {
  /** Project root — used by the compiler's cache directory and for resolving imports. */
  rootDir: string
  /** Emit inline source maps from the compiler. Default: true. */
  sourceMap?: boolean
  /** Verbose compiler logging. */
  verbose?: boolean
}

/**
 * Create the esbuild plugin. Instantiate once per build — the plugin holds
 * a `PtsCompiler` instance internally and reuses it across `onLoad` calls.
 */
export function justscaleProcessPlugin(opts: ProcessPluginOptions): Plugin {
  return {
    name: 'justscale-process',
    async setup(build) {
      let compiler: { compile(path: string): { code: string } } | null = null;

      async function getCompiler() {
        if (compiler) return compiler;
        let mod: typeof import('@justscale/typescript/loader');
        try {
          mod = await import('@justscale/typescript/loader');
        } catch (err) {
          throw new Error(
            "Process files were found but '@justscale/typescript' is not installed. " +
            "Install it to bundle apps that use '@justscale/core/process': " +
            'pnpm add -D @justscale/typescript\n' +
            `Underlying error: ${(err as Error).message}`,
            { cause: err },
          );
        }
        compiler = new mod.PtsCompiler({
          rootDir: opts.rootDir,
          sourceMap: opts.sourceMap ?? true,
          verbose: opts.verbose ?? false,
        });
        return compiler;
      }

      build.onLoad({ filter: /\.ts$/, namespace: 'file' }, async (args) => {
        const source = readFileSync(args.path, 'utf-8');
        if (!looksLikeProcessFile(args.path, source)) return null;

        const c = await getCompiler();
        const { code } = c.compile(args.path);
        // Return as JS so esbuild doesn't reapply TS transforms on our
        // already-compiled output. The inline sourceMappingURL in `code`
        // threads through to the final bundle map automatically.
        return { contents: code, loader: 'js' };
      });
    },
  };
}
