/**
 * Node.js ESM Loader for Process TypeScript and Proto files
 *
 * This loader hooks into Node.js module loading to:
 * 1. Compile process files (*.process.ts or files importing @justscale/core/process)
 * 2. Transform .proto imports to JavaScript
 *
 * Usage:
 *   node --import @justscale/typescript/register --import tsx ./app.ts
 */

import { fileURLToPath } from 'node:url';
import { dirname, basename, relative } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { PtsCompiler } from './incremental.js';
import '../plugins/index.js';
import { getPlugins, type FormatResolver } from '../plugins/types.js';

// Singleton compiler instance
let compiler: PtsCompiler | null = null;
// Per-plugin resolver singletons (index matches getPlugins())
let pluginResolvers: FormatResolver[] | null = null;
// Project root cache: computed once from cwd at first compile.
let projectRoot: string | null = null;

function getProjectRoot(): string {
  if (!projectRoot) projectRoot = findProjectRoot(process.cwd());
  return projectRoot;
}

function getCompiler(): PtsCompiler {
  if (!compiler) {
    compiler = new PtsCompiler({
      rootDir: getProjectRoot(),
      verbose: process.env.PTS_VERBOSE === '1',
      sourceMap: process.env.PTS_SOURCEMAP !== '0',
    });
  }
  return compiler;
}

/**
 * Verify a file path is inside the project root after symlink resolution.
 * Used to prevent the loader from compiling a process file that escaped
 * via symlink or absolute-path import — those should fall through to tsx
 * (treated as plain TypeScript) rather than getting our process-runtime
 * codegen and access to internal opcodes.
 *
 * Conservative: returns true only when the realpath is provably inside
 * the root. Returns false on stat errors so suspicious paths fall through
 * to the safer code path.
 */
function isInsideProjectRoot(filePath: string): boolean {
  return _isInsideRoot(filePath, getProjectRoot());
}

/** Exported for unit tests; takes an explicit root rather than using cwd. */
export function _isInsideRoot(filePath: string, root: string): boolean {
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(filePath);
    // Realpath the root too — on macOS, tmpdir() returns /var/folders/...
    // which realpaths to /private/var/folders/..., and a comparison
    // without normalizing both ends would produce a false negative for
    // legitimately-in-root files.
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const rel = relative(realRoot, real);
  // Empty rel means the file IS the root (impossible for files but be
  // explicit). Any rel starting with `..` means we walked OUT of root.
  if (rel === '' || rel.startsWith('..')) return false;
  // Defense against `subdir/../escape` style paths that happen to resolve
  // back inside but contain literal `..` segments — relative() normalizes,
  // but be paranoid against future bugs.
  return !rel.split(/[/\\]/).includes('..');
}

function getPluginResolvers(): FormatResolver[] {
  if (!pluginResolvers) {
    const baseDir = process.cwd();
    pluginResolvers = getPlugins().map(plugin =>
      plugin.createResolver({ baseDir, sourceMapMode: 'inline' })
    );
  }
  return pluginResolvers;
}

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(dir + '/package.json')) {
      return dir;
    }
    dir = dirname(dir);
  }
  return startDir;
}

/**
 * Check if a file is a process file that needs special compilation.
 * A file is a process file if:
 * - It matches *.process.ts naming convention
 * - It imports from '@justscale/core/process' and contains createProcess
 */
function isProcessFile(filePath: string, source?: string): boolean {
  const fileName = basename(filePath);

  // Quick check: *.process.ts naming convention
  if (fileName.includes('.process.')) {
    return true;
  }

  // Read source if not provided
  if (!source) {
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch {
      return false;
    }
  }

  // Check for @justscale/core/process import AND createProcess usage
  if (source.includes('@justscale/core/process') && source.includes('createProcess')) {
    return true;
  }

  return false;
}

interface ResolveContext {
  conditions: string[]
  parentURL?: string
}

interface ResolveResult {
  url: string
  format?: string
  shortCircuit?: boolean
}

type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

interface LoadContext {
  format?: string
  conditions: string[]
}

interface LoadResult {
  format: string
  source: string | ArrayBuffer
  shortCircuit?: boolean
}

type NextLoad = (url: string, context: LoadContext) => Promise<LoadResult>;

/**
 * Resolve hook - handles format imports (.proto, .capnp, .graphql/.gql).
 * Tells Node.js where to find these files and marks them as ESM modules.
 */
export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve
): Promise<ResolveResult> {
  const plugins = getPlugins();
  const isFormatImport = plugins.some(p => p.extensions.some(ext => specifier.endsWith(ext)));

  if (isFormatImport) {
    if (specifier.startsWith('.') && context.parentURL) {
      return {
        url: new URL(specifier, context.parentURL).href,
        format: 'module',
        shortCircuit: true,
      };
    }
    return {
      url: new URL(specifier, 'file://').href,
      format: 'module',
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}

/**
 * Load hook - intercepts .ts files and compiles process files specially.
 * Also handles .proto files for direct proto imports.
 * Non-process .ts files are forwarded to the next loader (tsx).
 */
export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad
): Promise<LoadResult> {
  // Skip node_modules and declaration files
  if (url.includes('node_modules') || url.endsWith('.d.ts')) {
    return nextLoad(url, context);
  }

  // Handle format-specific files (.proto, .capnp, .graphql, .gql)
  const plugins = getPlugins();
  const resolvers = getPluginResolvers();
  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i];
    const isMatch = plugin.extensions.some(ext => url.endsWith(ext));
    if (isMatch) {
      const filePath = fileURLToPath(url);
      const resolver = resolvers[i];
      const info = resolver.resolveModule(filePath, filePath);

      if (!info) {
        throw new Error(`[${plugin.name}-loader] Failed to resolve: ${filePath}`);
      }

      if (info.errors.length > 0) {
        const errorMessages = info.errors
          .filter(e => e.severity === 'error')
          .map(e => `  ${e.message}`)
          .join('\n');
        if (errorMessages) {
          console.error(`[${plugin.name}-loader] Errors in ${filePath}:\n${errorMessages}`);
        }
      }

      if (process.env.PTS_VERBOSE === '1') {
        console.log(`[${plugin.name}-loader] Compiled: ${filePath}`);
      }

      return {
        format: 'module',
        source: info.runtime,
        shortCircuit: true,
      };
    }
  }

  // Handle both .ts and .js extensions (ESM imports use .js even for .ts files)
  let filePath: string;
  if (url.endsWith('.ts')) {
    filePath = fileURLToPath(url);
  } else if (url.endsWith('.js')) {
    // Try to resolve .js to .ts file
    const jsPath = fileURLToPath(url);
    const tsPath = jsPath.replace(/\.js$/, '.ts');
    if (existsSync(tsPath)) {
      filePath = tsPath;
    } else {
      return nextLoad(url, context);
    }
  } else {
    return nextLoad(url, context);
  }

  // Check if this is a process file
  if (!isProcessFile(filePath)) {
    // Not a process file - let tsx handle it
    return nextLoad(url, context);
  }

  // Project-root scoping: a process file that resolves (via symlink or
  // absolute import) to outside the project must NOT be compiled with
  // our transformer. The transformer assumes the source is trusted
  // project code — running it on a hostile path would emit the file's
  // contents into our process-runtime codegen path. Fall through to tsx
  // for plain-TS handling instead.
  if (!isInsideProjectRoot(filePath)) {
    if (process.env.PTS_VERBOSE === '1') {
      console.warn(`[process-loader] Refusing to compile out-of-root path as process: ${filePath}`);
    }
    return nextLoad(url, context);
  }

  // It's a process file - compile with our transformer
  const ptsCompiler = getCompiler();

  try {
    const result = ptsCompiler.compile(filePath);

    if (process.env.PTS_VERBOSE === '1') {
      console.log(`[process-loader] ${result.cached ? 'Cached' : 'Compiled'}: ${filePath}`);
    }

    return {
      format: 'module',
      source: result.code,
      shortCircuit: true,
    };
  } catch (error) {
    console.error(`[process-loader] Failed to compile ${filePath}:`, error);
    throw error;
  }
}

/**
 * Initialize hook - called when the loader is registered.
 */
export async function initialize(data?: { verbose?: boolean }): Promise<void> {
  if (data?.verbose) {
    process.env.PTS_VERBOSE = '1';
  }
}
