/**
 * Workspace CLI Controller
 *
 * Provides built-in commands for workspace operations:
 * - build: Build using TypeScript and Turbo
 * - run: Run a package, script, or file
 * - test: Run tests
 * - init: Set up project config, IDE, and AI tooling
 * - install: Install a JustScale plugin with optional wizard
 */

import { execSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, glob, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, homedir } from 'node:os';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createController } from '../core/index.js';
import { Cli } from './builder/index.js';
import type { CliIO } from './io.js';
import {
  detectSystem,
  generateJetBrainsConfig,
  generateVSCodeConfig,
  generateClaudeConfig,
  generateCursorConfig,
  generateGitHubActions,
  generateGitLabCI,
} from './generators/index.js';
import type { WizardContext } from './wizard.js';

// ============================================================================
// Types
// ============================================================================

interface BuildArgs {
  filter?: string
  watch: boolean
  verbose: boolean
  env?: string
}

interface RunArgs {
  target?: string
  verbose: boolean
  env?: string
}

interface TestArgs {
  filter?: string
  pattern?: string[]
  grep?: string
  watch: boolean
  bail: boolean
  only: boolean
  timeout: number
  concurrency?: number
  reporter: 'spec' | 'tap' | 'dot'
  changed: boolean
  verbose: boolean
  skipTypecheck: boolean
  env?: string
}

interface CliContext<TArgs> {
  args: TArgs
  io: CliIO<unknown>
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Find the workspace root by looking for pnpm-workspace.yaml.
 */
export function findWorkspaceRoot(startDir?: string): string {
  let dir = startDir ?? process.cwd();

  while (dir !== '/') {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return process.cwd();
}

/**
 * Is `dir` a real monorepo root that turbo should orchestrate? Two signals:
 *   - a `turbo.json` (turbo is explicitly configured), or
 *   - a `pnpm-workspace.yaml` that actually declares `packages:`.
 *
 * A `pnpm-workspace.yaml` carrying only settings (e.g. `allowBuilds` /
 * `onlyBuiltDependencies` to pre-approve pnpm build scripts) is NOT a
 * monorepo — a single app can have one. Keying off mere file existence
 * mis-routed `just build`/`just test` in scaffolded apps to turbo, which
 * then failed with "missing field `packages`" / found no tests.
 */
export function isMonorepoRoot(dir: string): boolean {
  if (existsSync(join(dir, 'turbo.json'))) return true;
  const ws = join(dir, 'pnpm-workspace.yaml');
  if (!existsSync(ws)) return false;
  try {
    // `packages:` is a top-level key in a real workspace file.
    return /^packages\s*:/m.test(readFileSync(ws, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Execute a command and stream output.
 *
 * Prepends local `node_modules/.bin` to PATH so commands like `tsx`,
 * `ptsc`, and `turbo` resolve even when the spawned process doesn't
 * inherit the interactive shell's PATH munging. Without this, a plain
 * `spawn('tsx', ...)` hits ENOENT because Node uses execvp with the
 * child's PATH (which excludes the project's .bin).
 */
function exec(
  command: string,
  args: string[],
  options: { cwd?: string; verbose?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const baseEnv = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const binDirs = [
      join(cwd, 'node_modules', '.bin'),
      join(findWorkspaceRoot(cwd), 'node_modules', '.bin'),
    ];
    const sep = process.platform === 'win32' ? ';' : ':';
    const env = {
      ...baseEnv,
      PATH: [...binDirs, baseEnv.PATH ?? ''].filter(Boolean).join(sep),
    };

    const proc = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      env,
    });

    proc.on('close', (code) => {
      resolve(code ?? 0);
    });

    proc.on('error', () => {
      resolve(1);
    });
  });
}

/**
 * Build a child process env with JUSTSCALE_ENV set (if requested).
 * Other env vars are inherited from the parent.
 */
function envWithJustscaleEnv(envName?: string): NodeJS.ProcessEnv {
  if (!envName) return process.env;
  return { ...process.env, JUSTSCALE_ENV: envName };
}

// ============================================================================
// Shell-completion install (idempotent)
// ============================================================================

type SupportedShell = 'bash' | 'zsh' | 'fish';

/** Marker line used to detect a previously-installed completion entry. */
const COMPLETION_MARKER = '# justscale:tab-completion';

function detectShell(): SupportedShell | undefined {
  const shell = process.env.SHELL ?? '';
  if (/\/(bash)(\.exe)?$/.test(shell)) return 'bash';
  if (/\/(zsh)(\.exe)?$/.test(shell)) return 'zsh';
  if (/\/(fish)$/.test(shell)) return 'fish';
  return undefined;
}

/**
 * Where the snippet should live for the given shell. For bash/zsh that's
 * the user's rc file (we'll create it if missing). For fish it's a file
 * inside `~/.config/fish/completions/` which fish auto-discovers — so the
 * install is "drop the full script" rather than "source from rc".
 */
function completionTargetFor(shell: SupportedShell): string {
  const home = homedir();
  if (shell === 'zsh') return join(home, '.zshrc');
  if (shell === 'fish') return join(home, '.config', 'fish', 'completions', 'just.fish');
  const bashrc = join(home, '.bashrc');
  const bashProfile = join(home, '.bash_profile');
  return existsSync(bashrc) || !existsSync(bashProfile) ? bashrc : bashProfile;
}

function isAlreadyInstalled(target: string): boolean {
  if (!existsSync(target)) return false;
  try {
    return readFileSync(target, 'utf8').includes(COMPLETION_MARKER);
  } catch {
    return false;
  }
}

/**
 * Heuristic: is this invocation running in a developer's interactive
 * workflow (as opposed to CI, prod, or a scripted test run)?
 *
 * - `CI=true` or `CI=1` — universal CI signal, skip.
 * - `NODE_ENV` or `JUSTSCALE_ENV` explicitly set to anything other than
 *   `development`/`dev` — respect it; we're not dev-mode.
 * - Otherwise: assume dev.
 *
 * Keeps prod servers, migration jobs, and CI pipelines from silently
 * mutating the operator's shell rc.
 */
function isDevInvocation(): boolean {
  if (process.env.CI && process.env.CI !== '0' && process.env.CI !== 'false') return false;
  const nodeEnv = (process.env.NODE_ENV ?? '').toLowerCase();
  const justEnv = (process.env.JUSTSCALE_ENV ?? '').toLowerCase();
  for (const v of [nodeEnv, justEnv]) {
    if (!v) continue;
    if (v === 'development' || v === 'dev') continue;
    return false;
  }
  return true;
}

/**
 * Idempotently install tab-completion for the current shell. Returns a
 * short status string when a change was made (to show the user), or
 * `null` when there was nothing to do (already installed, unsupported
 * shell, non-dev environment, or completion intentionally opted out).
 *
 * `force: true` bypasses the dev-mode gate and the opt-out env var —
 * used by the explicit `just completion install` command.
 */
export function installShellCompletion(opts: { force?: boolean } = {}): string | null {
  if (!opts.force) {
    // Opt-out hatch — CI, sandboxed environments, or users who've set
    // up completion via a package manager shouldn't be surprised by
    // writes to their shell rc on every `just ...` call.
    if (process.env.JUSTSCALE_NO_COMPLETION_INSTALL === '1') return null;
    // Dev-only gate — never mutate rc files on prod/CI/test runs.
    if (!isDevInvocation()) return null;
  }

  const shell = detectShell();
  if (!shell) return null;

  const target = completionTargetFor(shell);
  if (isAlreadyInstalled(target) && !opts.force) return null;

  if (shell === 'fish') {
    // Fish auto-loads files under completions/; drop the whole script.
    mkdirSync(dirname(target), { recursive: true });
    const body = `${COMPLETION_MARKER}\n${renderCompletionScript('fish')}\n`;
    writeFileSync(target, body, 'utf8');
    return `[just] wrote tab-completion to ${displayPath(target)} — open a new shell to activate`;
  }

  // bash / zsh → append the full completion function inline. No
  // `source <(just ...)` at shell-startup time — the snippet is
  // self-contained so shells start cleanly even if the `just` binary
  // isn't on PATH when they open.
  const block = `\n${COMPLETION_MARKER}\n${renderCompletionScript(shell)}\n`;
  appendFileSync(target, block, 'utf8');
  return `[just] enabled tab-completion in ${displayPath(target)} — open a new shell to activate`;
}

function displayPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Resolve `--import` args for child test workers spawned by `node:test`'s
 * `run()`. We always try to pre-load the process compiler (so `.process.ts`
 * and anything importing `@justscale/core/process` compiles correctly) and
 * tsx (for plain `.ts` under Node's loader). Missing packages are skipped —
 * Node 24+ type-stripping covers simple cases.
 */
function buildTestExecArgv(cwd: string): string[] {
  const execArgv: string[] = [];
  const req = createRequire(`${cwd}/`);
  for (const spec of ['@justscale/typescript/register', 'tsx']) {
    try {
      req.resolve(spec);
      execArgv.push('--import', spec);
    } catch {
      // package not installed in the user's project — skip
    }
  }
  return execArgv;
}

/**
 * Discover workspace packages that have a `test` script. Uses turbo's dep
 * graph so `--changed` respects package-level change detection, matching
 * `pnpm test:changed`. Filter is a substring on the package directory path.
 */
function getWorkspaceTestDirs(opts: {
  root: string
  filter?: string
  changed: boolean
}): string[] {
  const { root, filter, changed } = opts;
  const filterArg = changed ? '--filter=...[origin/main]' : '';

  try {
    const output = execSync(`pnpm turbo run test ${filterArg} --dry-run=json`, {
      encoding: 'utf-8',
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const data = JSON.parse(output);
    return (data.tasks as Array<{ task: string; directory: string }>)
      .filter((t) => t.task === 'test')
      .map((t) => join(root, t.directory))
      .filter((dir) => !filter || dir.includes(filter));
  } catch {
    return [];
  }
}

/**
 * Extract file globs from a package's `test` script. Falls back to sane
 * defaults when the script doesn't include explicit patterns. Mirrors the
 * repo's `test/run.ts` heuristic so behavior stays consistent whether you
 * invoke tests via `pnpm test` or `just test`.
 */
function extractTestGlobs(pkgDir: string): string[] {
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return [];
  let testScript: string;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    testScript = pkg.scripts?.test ?? '';
  } catch {
    return [];
  }
  const matches = testScript.match(/['"]?[^\s'"]*\*[^\s'"]*\.test\.ts['"]?/g);
  if (matches && matches.length > 0) {
    return matches.map((m) => m.replace(/['"]/g, ''));
  }
  return ['test/**/*.test.ts', 'src/**/*.test.ts'];
}

async function expandGlobs(globs: string[], cwd: string): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of globs) {
    for await (const file of glob(pattern, { cwd })) {
      files.push(join(cwd, file));
    }
  }
  return files;
}

interface ResolveTestFilesOptions {
  cwd: string
  root: string
  isAtRoot: boolean
  pattern?: string[]
  filter?: string
  changed: boolean
}

async function resolveTestFiles(opts: ResolveTestFilesOptions): Promise<string[]> {
  const { cwd, root, isAtRoot, pattern, filter, changed } = opts;

  if (pattern && pattern.length > 0) {
    return (await expandGlobs(pattern, cwd)).sort();
  }

  if (!isAtRoot) {
    return (await expandGlobs(['test/**/*.test.ts', 'src/**/*.test.ts'], cwd)).sort();
  }

  const dirs = getWorkspaceTestDirs({ root, filter, changed });
  const all: string[] = [];
  for (const dir of dirs) {
    const globs = extractTestGlobs(dir);
    all.push(...(await expandGlobs(globs, dir)));
  }
  return all.sort();
}

// ============================================================================
// App-mode build (bundler)
// ============================================================================

interface AppBuildOptions {
  cwd: string
  envName: string
  verbose: boolean
  log: (msg: string) => void
  error: (msg: string) => void
}

async function buildApp(opts: AppBuildOptions): Promise<number> {
  const { cwd, envName, verbose, log, error } = opts;

  const { discover } = await import('./discovery.js');
  const result = await discover();
  if (!result) {
    error('App-mode build requires a justscale.config.ts in the current directory.');
    return 1;
  }
  if (!result.config.app) {
    error('justscale.config.ts has no `app` entry. Define one via defineProject({ app: ... }).');
    return 1;
  }

  const { loadEnvironment } = await import('../features/environment/load.js');
  let env: { type: string };
  try {
    env = await loadEnvironment({
      name: envName,
      from: { url: result.configFileUrl },
    });
  } catch (err) {
    error(`Failed to load environment '${envName}': ${(err as Error).message}`);
    return 1;
  }

  const { resolveAppEntry } = await import('./define-project.js');
  const entry = resolveAppEntry(result.configFileUrl, result.config.app, env.type as any);
  if (!entry) {
    error(
      `Could not resolve app entry for env '${envName}' (type='${env.type}'). ` +
      'Ensure config.app is a `() => import(\'./path.js\')` form and the file exists.',
    );
    return 1;
  }

  // esbuild is an optional peer dep — apps that never run app-mode build
  // shouldn't carry the bundler. Dynamic-import with a helpful error.
  let esbuild: typeof import('esbuild');
  try {
    esbuild = await import('esbuild');
  } catch (err) {
    error(
      'App-mode build requires esbuild. Install it as a dev dep: pnpm add -D esbuild\n' +
      `Underlying error: ${(err as Error).message}`,
    );
    return 1;
  }

  const { justscaleProcessPlugin } = await import('./build/process-plugin.js');
  const { justscaleMigrationsPlugin } = await import('./build/migrations-plugin.js');

  const configDir = dirname(fileURLToPath(result.configFileUrl));
  const outDir = result.config.build?.outDir
    ? resolvePath(configDir, result.config.build.outDir)
    : join(configDir, 'dist');
  mkdirSync(outDir, { recursive: true });

  const entryBase = basename(entry).replace(/\.(m|c)?(ts|js)$/, '');
  const outFile = join(outDir, `${entryBase}-${envName}.js`);
  const metaFile = join(outDir, `${entryBase}-${envName}.meta.json`);

  // Locate the env file now (not during bundling) so we can fail fast with
  // a clear message when it's missing, and so we can inline its absolute
  // path into the virtual entry's import statement.
  const envFileCandidates = [
    join(configDir, 'env', `${envName}.ts`),
    join(configDir, 'env', `${envName}.js`),
    join(configDir, 'env', `${envName}.mjs`),
  ];
  const envFile = envFileCandidates.find((p) => existsSync(p));
  if (!envFile) {
    error(
      `Could not find env file for '${envName}'. Looked in:\n  ` +
      envFileCandidates.map((p) => relative(cwd, p)).join('\n  '),
    );
    return 1;
  }

  // Env registration has to happen BEFORE the user's app module evaluates,
  // because `defineApp` autoruns `loadEnvironment({ from: meta })` during
  // module eval (via an async IIFE) when invoked from the entrypoint.
  // ESM evaluates a module's dependencies in declaration order before the
  // module body runs, so the first import in the virtual entry is a
  // synthetic side-effect module that performs the registration. It
  // evaluates first, env is in the registry, then `src/app.ts` evaluates
  // and its autorun path finds the static env.
  const REGISTER_SPECIFIER = 'justscale:static-env-register';
  const virtualEntrySource =
    `import ${JSON.stringify(REGISTER_SPECIFIER)};\n` +
    `import __appDefault from ${JSON.stringify(entry)};\n` +
    'export default __appDefault;\n';

  const envRegisterPlugin: import('esbuild').Plugin = {
    name: 'justscale-static-env-register',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${REGISTER_SPECIFIER}$`) }, () => ({
        path: REGISTER_SPECIFIER,
        namespace: 'justscale-static-env',
      }));
      build.onLoad({ filter: /.*/, namespace: 'justscale-static-env' }, () => ({
        resolveDir: configDir,
        loader: 'ts',
        contents:
          `import __envModule from ${JSON.stringify(envFile)};\n` +
          'import { __registerStaticEnvironment } from \'@justscale/core\';\n' +
          `__registerStaticEnvironment(${JSON.stringify(envName)}, __envModule);\n`,
      }));
    },
  };

  log(`Bundling ${relative(cwd, entry)} → ${relative(cwd, outFile)} (env=${envName}, type=${env.type})`);

  const started = Date.now();
  try {
    await esbuild.build({
      stdin: {
        contents: virtualEntrySource,
        resolveDir: configDir,
        sourcefile: `${entryBase}-${envName}.entry.ts`,
        loader: 'ts',
      },
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: result.config.build?.target ?? 'node24',
      // Bundle everything into a single file so the deploy artifact needs
      // nothing from node_modules at runtime except the packages explicitly
      // kept external (native modules, things listed in config.build.external).
      // `platform: 'node'` auto-externalizes `node:*` builtins.
      external: result.config.build?.external ?? [],
      sourcemap: true,
      treeShaking: true,
      // Collapse whitespace only — keep names readable so stack traces
      // map cleanly without a sourcemap. Real identifier minification is
      // opt-in later (users that want it can set it via config).
      minifyWhitespace: true,
      logLevel: verbose ? 'info' : 'warning',
      define: {
        'process.env.JUSTSCALE_ENV': JSON.stringify(envName),
        'process.env.NODE_ENV':
          env.type === 'production' ? '"production"' : JSON.stringify(env.type),
      },
      plugins: [
        envRegisterPlugin,
        justscaleProcessPlugin({ rootDir: configDir, sourceMap: true, verbose }),
        justscaleMigrationsPlugin({ rootDir: configDir }),
      ],
      banner: {
        // Re-enable dynamic require() for ESM output so bundled CJS deps
        // (which occasionally call `require` internally via shims) and any
        // externalized CJS packages still resolve after the bundle runs.
        js: "import { createRequire as __jsCreateRequire } from 'node:module';"
          + 'const require = __jsCreateRequire(import.meta.url);',
      },
    });
  } catch (err) {
    error(`esbuild failed: ${(err as Error).message}`);
    return 1;
  }

  // Copy include patterns (e.g. migrations) into the output directory so
  // the deploy artifact is self-contained. Relative paths are preserved:
  // `migrations/001.sql` → `dist/migrations/001.sql`. `withFileTypes: true`
  // lets us skip directory entries — `copyFile` only handles files, and
  // globs like `migrations/**` also match the containing directory.
  const includePatterns = result.config.build?.include ?? [];
  const copiedFiles: string[] = [];
  for (const pattern of includePatterns) {
    for await (const entry of glob(pattern, { cwd: configDir, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const rel = relative(configDir, join(entry.parentPath, entry.name));
      const src = join(configDir, rel);
      const dst = join(outDir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      copiedFiles.push(rel);
    }
  }

  const meta = {
    env: envName,
    envType: env.type,
    entry: relative(configDir, entry),
    bundle: relative(configDir, outFile),
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    include: copiedFiles,
  };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');

  log(`  ✓ bundle: ${relative(cwd, outFile)}`);
  log(`  ✓ meta:   ${relative(cwd, metaFile)}`);
  if (copiedFiles.length > 0) {
    log(`  ✓ include: ${copiedFiles.length} file${copiedFiles.length === 1 ? '' : 's'}`);
  }
  log(`  Built in ${meta.durationMs}ms`);
  return 0;
}

// ============================================================================
// Input Schemas
// ============================================================================

const BuildInput = z.object({
  filter: z.string().optional().describe('Build specific package(s)'),
  watch: z.boolean().default(false).describe('Watch mode for incremental builds'),
  verbose: z.boolean().default(false).describe('Verbose output'),
  env: z.string().optional().describe('Environment name (sets JUSTSCALE_ENV)'),
});

const RunInput = z.object({
  // Explicit position: 0 via CLI metadata keeps this positional even when
  // .optional() would otherwise flip it to a flag. Convention-only parsing
  // treats any optional/defaulted field as a flag; explicit metadata wins.
  target: z.string().optional().meta({
    cli: {
      position: 0,
      description: 'File path, package name, or script name. Omit to run the current package\'s app entry (src/app.ts).',
    },
  }),
  verbose: z.boolean().default(false).describe('Verbose output'),
  env: z.string().optional().describe('Environment name (sets JUSTSCALE_ENV)'),
});

const TestInput = z.object({
  filter: z.string().optional().describe('Run tests only for packages matching this name (workspace mode)'),
  pattern: z.array(z.string()).optional().describe('Test file glob(s). Repeat for multiple. Default: test/**/*.test.ts, src/**/*.test.ts'),
  grep: z.string().optional().describe('Run only tests whose name matches this regex'),
  watch: z.boolean().default(false).describe('Watch files and re-run on change'),
  bail: z.boolean().default(false).describe('Stop at the first failure'),
  only: z.boolean().default(false).describe('Run only tests marked with .only'),
  timeout: z.number().default(10_000).describe('Per-test timeout in ms'),
  concurrency: z.number().optional().describe('Max concurrent test files (default: cpus-1)'),
  reporter: z.enum(['spec', 'tap', 'dot']).default('spec').describe('Output reporter'),
  changed: z.boolean().default(false).describe('Only run tests in packages changed vs origin/main (workspace mode)'),
  verbose: z.boolean().default(false).describe('Verbose output'),
  skipTypecheck: z.boolean().default(false).describe('Skip typecheck before running tests'),
  env: z.string().optional().describe('Environment name (sets JUSTSCALE_ENV, default: test)'),
});

// ============================================================================
// Controller
// ============================================================================

export const WorkspaceController = createController({
  // No command prefix - these are root-level commands
  inject: {},
  routes: () => ({
    build: Cli('build')
      .input(BuildInput)
      .handle(async (ctx: CliContext<BuildArgs>) => {
        const { filter, watch, verbose } = ctx.args;
        // `--env` is consumed as a global flag by `main.ts`; it lands
        // in `process.env.JUSTSCALE_ENV`. Fall through to ctx.args.env
        // for the rare call-site that set it directly.
        const env = ctx.args.env ?? process.env.JUSTSCALE_ENV ?? undefined;
        const cwd = process.cwd();
        const workspaceRoot = findWorkspaceRoot();
        const isWorkspace = isMonorepoRoot(workspaceRoot);
        const childEnv = envWithJustscaleEnv(env);

        // App mode: `--env <name>` + a justscale.config.ts in cwd means
        // "build a deployable artifact for this env", not "compile TS for
        // publishing". Bundler path, output lands at dist/<entry>-<env>.js.
        // Watch and workspace filter don't apply here — this is a one-shot
        // artifact build.
        const hasProjectConfig =
          existsSync(join(cwd, 'justscale.config.ts')) ||
          existsSync(join(cwd, 'justscale.config.js'));
        if (env && hasProjectConfig && !watch) {
          const code = await buildApp({
            cwd,
            envName: env,
            verbose,
            log: (m) => ctx.io.log(m),
            error: (m) => ctx.io.error(m),
          });
          process.exit(code);
        }

        if (env) ctx.io.log(`Using environment: ${env}`);

        if (watch) {
          ctx.io.log('Starting watch mode...');
          const args = ['--build', '--watch'];
          if (verbose) args.push('--verbose');
          const code = await exec('ptsc', args, { cwd, verbose, env: childEnv });
          process.exit(code);
        }

        if (isWorkspace) {
          // Monorepo — use turbo for orchestrated builds
          const args = ['run', 'build'];
          if (filter) args.push('--filter', filter);
          if (verbose) args.push('--verbose');

          ctx.io.log(`Building${filter ? ` ${filter}` : ' all packages'}...`);
          const code = await exec('turbo', args, { cwd: workspaceRoot, verbose, env: childEnv });
          process.exit(code);
        }

        // Single project — use ptsc directly from cwd
        ctx.io.log('Building...');
        const tsconfigBuild = join(cwd, 'tsconfig.build.json');
        const args = existsSync(tsconfigBuild)
          ? ['-b', 'tsconfig.build.json']
          : ['--outDir', 'dist'];
        if (verbose) args.push('--verbose');

        const code = await exec('ptsc', args, { cwd, verbose, env: childEnv });
        process.exit(code);
      }),

    run: Cli('run')
      .input(RunInput)
      .handle(async (ctx: CliContext<RunArgs>) => {
        const { target, verbose, env } = ctx.args;
        const root = findWorkspaceRoot();
        const childEnv = envWithJustscaleEnv(env);

        if (env && verbose) ctx.io.log(`Using environment: ${env}`);

        // No target → run the user's app entry (defineApp default export
        // at src/app.ts). Same shape as `just dev` minus the watcher.
        if (!target) {
          const cwd = process.cwd();
          const candidates = ['src/app.ts', 'src/main.ts', 'src/server.ts', 'src/serve.ts'];
          const entry = candidates.map((c) => join(cwd, c)).find((p) => existsSync(p));
          if (!entry) {
            ctx.io.error('Error: No app entry found and no target specified.');
            ctx.io.log('Usage: just run <target>  |  run from a package with src/app.ts');
            process.exit(1);
          }
          if (verbose) ctx.io.log(`Running ${entry}...`);
          const code = await exec('tsx', [entry], { cwd, verbose, env: childEnv });
          process.exit(code);
        }

        // Check if it's a file path
        if (target.endsWith('.ts') || target.endsWith('.js')) {
          const filePath = target.startsWith('/') ? target : join(root, target);
          if (!existsSync(filePath)) {
            ctx.io.error(`Error: File not found: ${filePath}`);
            process.exit(1);
          }

          if (verbose) ctx.io.log(`Running ${filePath}...`);
          const code = await exec('tsx', [filePath], { cwd: root, verbose, env: childEnv });
          process.exit(code);
        }

        // Check if it's a root package.json script
        const pkgPath = join(root, 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
          if (pkg.scripts?.[target]) {
            if (verbose) ctx.io.log(`Running script: ${target}`);
            const code = await exec('pnpm', ['run', target], { cwd: root, verbose, env: childEnv });
            process.exit(code);
          }
        }

        // Try running as package
        if (verbose) ctx.io.log(`Running package: ${target}`);
        const code = await exec('pnpm', ['--filter', target, 'start'], { cwd: root, verbose, env: childEnv });
        process.exit(code);
      }),

    test: Cli('test')
      .input(TestInput)
      .handle(async (ctx: CliContext<TestArgs>) => {
        const {
          filter, pattern, grep, watch, bail, only, timeout, concurrency,
          reporter, changed, verbose, skipTypecheck,
        } = ctx.args;
        // `--env` is a global flag on the `just` binary; it lands in
        // process.env.JUSTSCALE_ENV. Fall through to ctx.args.env for
        // the rare direct call site that set it programmatically.
        const env = ctx.args.env ?? process.env.JUSTSCALE_ENV;

        const cwd = process.cwd();
        const root = findWorkspaceRoot(cwd);
        // Only a real monorepo root sweeps tests across workspace packages; a
        // settings-only pnpm-workspace.yaml (no `packages:`) is a single app
        // and gets single-package discovery.
        const isAtRoot = cwd === root && isMonorepoRoot(root);

        // Default to the 'test' env so configs/adapters with environment-
        // gated behavior (pglite, in-memory channels, …) pick the test
        // variant without the user having to type `--env test` every run.
        process.env.JUSTSCALE_ENV = env ?? 'test';
        if (env && verbose) ctx.io.log(`Using environment: ${env}`);

        // Typecheck: scope to cwd in single-package mode so running tests
        // inside e.g. examples/simple-app doesn't drag in the whole
        // monorepo's typecheck cost.
        if (!skipTypecheck) {
          ctx.io.log('Running typecheck...');
          const typecheckCwd = isAtRoot ? root : cwd;
          const code = await exec('pnpm', ['typecheck'], { cwd: typecheckCwd, verbose });
          if (code !== 0) {
            ctx.io.error('Typecheck failed');
            process.exit(code);
          }
        }

        const files = await resolveTestFiles({ cwd, root, isAtRoot, pattern, filter, changed });
        if (files.length === 0) {
          ctx.io.log('No test files found.');
          if (filter) ctx.io.log(`  (no packages matched --filter=${filter})`);
          else if (changed) ctx.io.log('  (no changes detected vs origin/main)');
          process.exit(0);
        }

        if (verbose) {
          for (const f of files) ctx.io.log(`  ${relative(cwd, f)}`);
        }
        ctx.io.log(
          `Running ${files.length} test file${files.length === 1 ? '' : 's'}` +
          `${filter ? ` (filter: ${filter})` : ''}${changed ? ' (changed)' : ''}...`,
        );

        const { run } = await import('node:test');
        const { spec, tap, dot } = await import('node:test/reporters');
        const reporterFactory = { spec, tap, dot }[reporter];

        const controller = new AbortController();
        const runOptions: Parameters<typeof run>[0] = {
          files,
          timeout,
          concurrency: concurrency ?? Math.max(1, cpus().length - 1),
          forceExit: !watch,
          watch,
          only,
          execArgv: buildTestExecArgv(cwd),
          signal: controller.signal,
        };
        if (grep) runOptions.testNamePatterns = [grep];

        const stream = run(runOptions);

        let failed = 0;
        stream.on('test:fail', (ev) => {
          // Node reports test suites with failing children as 'test:fail'
          // too; those carry a `subtest` flag. Count only leaf failures so
          // bail semantics match what the user sees in the spec output.
          const details = (ev as { details?: { type?: string } }).details;
          if (details?.type === 'suite') return;
          failed++;
          if (bail) controller.abort();
        });

        const output = stream.compose(reporterFactory);
        output.pipe(process.stdout);

        await new Promise<void>((resolve, reject) => {
          output.once('end', resolve);
          output.once('error', reject);
        });

        if (watch) return; // watch never finishes naturally
        process.exit(failed > 0 ? 1 : 0);
      }),

    init: Cli('init')
      .handle(async (ctx: CliContext<{}>) => {
        const root = process.cwd();
        const system = detectSystem(root);

        ctx.io.log('JustScale — Project Setup\n');
        ctx.io.log(`  OS:              ${system.os} (${system.arch})`);
        ctx.io.log(`  Node:            ${system.nodeVersion}`);
        ctx.io.log(`  Package manager: ${system.packageManager}`);
        ctx.io.log(`  IDEs:            ${system.ides.length ? system.ides.join(', ') : 'none detected'}`);
        ctx.io.log(`  AI tools:        ${system.aiTools.length ? system.aiTools.join(', ') : 'none detected'}`);
        ctx.io.log(`  Git hosting:     ${system.gitHosting ?? 'not detected'}`);
        ctx.io.log('');

        const generated: string[] = [];

        // IDE config
        if (system.ides.includes('jetbrains')) {
          generated.push(...generateJetBrainsConfig(root));
        }
        if (system.ides.includes('vscode') || system.ides.includes('cursor')) {
          generated.push(...generateVSCodeConfig(root));
        }

        // AI config
        if (system.aiTools.includes('claude')) {
          generated.push(...generateClaudeConfig(root));
        }
        if (system.aiTools.includes('cursor')) {
          generated.push(...generateCursorConfig(root));
        }

        // CI/CD
        if (system.gitHosting === 'github') {
          generated.push(...generateGitHubActions(root));
        } else if (system.gitHosting === 'gitlab') {
          generated.push(...generateGitLabCI(root));
        }

        if (generated.length > 0) {
          ctx.io.log('Generated:');
          for (const file of generated) {
            ctx.io.log(`  ✓ ${file}`);
          }
        } else {
          ctx.io.log('Everything is already configured.');
        }
      }),

    install: Cli('install')
      .input(z.object({
        package: z.string().describe('Package name to install'),
      }))
      .handle(async (ctx: CliContext<{ package: string }>) => {
        const root = findWorkspaceRoot();
        const pkgName = ctx.args.package;

        ctx.io.log(`Installing ${pkgName}...`);

        // Install via detected package manager
        const pm = detectSystem(root).packageManager;
        const pmCmd = pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'yarn' : 'npm';
        const pmArgs = pm === 'npm' ? ['install', pkgName] : ['add', pkgName];
        const installCode = await exec(pmCmd, pmArgs, { cwd: root });

        if (installCode !== 0) {
          ctx.io.error(`Failed to install ${pkgName}`);
          process.exit(installCode);
        }

        ctx.io.log('  ✓ Package installed');

        // Check for justscale wizard
        const depPkgPath = join(root, 'node_modules', pkgName, 'package.json');
        if (!existsSync(depPkgPath)) return;

        let depPkg: any;
        try {
          depPkg = JSON.parse(readFileSync(depPkgPath, 'utf-8'));
        } catch {
          return;
        }

        const justscaleField = depPkg.justscale;
        if (!justscaleField?.wizard) return;

        // Resolve wizard module
        const depDir = join(depPkgPath, '..');
        const wizardConfig = justscaleField.wizard;
        let wizardPath: string | null = null;

        // Prefer import (built JS) over source (TS) — same as discovery.ts
        if (wizardConfig.import) {
          const candidate = join(depDir, wizardConfig.import);
          if (existsSync(candidate)) wizardPath = candidate;
        }
        if (!wizardPath && wizardConfig.source) {
          const candidate = join(depDir, wizardConfig.source);
          if (existsSync(candidate)) wizardPath = candidate;
        }

        if (!wizardPath) return;

        ctx.io.log('  Running setup wizard...\n');

        try {
          const wizardModule = await import(pathToFileURL(wizardPath).href);
          const wizardFn = wizardModule.default ?? wizardModule.wizard;
          if (typeof wizardFn !== 'function') return;

          const projectPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
          const wizardCtx: WizardContext = {
            io: ctx.io,
            project: {
              root,
              packageJson: projectPkg,
              hasDependency: (name: string) =>
                !!(projectPkg.dependencies?.[name] || projectPkg.devDependencies?.[name]),
            },
          };

          await wizardFn(wizardCtx);
        } catch (err: any) {
          ctx.io.error(`Wizard failed: ${err.message}`);
        }
      }),

    dev: Cli('dev')
      .handle(async (ctx: CliContext<{}>) => {
        // Use the invoking cwd so `cd examples/simple-app && just dev` picks
        // up that package's `src/app.ts`, not the monorepo root.
        const root = process.cwd();
        ctx.io.log('JustScale Dev Server\n');

        const { startDevServer } = await import('./dev-server.js');
        await startDevServer({
          root,
          log: (msg) => ctx.io.log(msg),
        });
      }),

    mcpServe: Cli('mcp serve')
      .handle(async (_ctx: CliContext<{}>) => {
        // MCP stdio mode — launched by Claude Code / Cursor. Uses the same
        // assembly path as the `just` binary so discovered package commands
        // resolve against the user's real DI container.
        try {
          const { startMcpStdio } = await import('./mcp/server.js');
          const { assembleCliApp } = await import('./assemble.js');

          const app = await assembleCliApp();
          await startMcpStdio(app);
        } catch (err: any) {
          process.stderr.write(`MCP server failed: ${err.message}\n`);
          process.exit(1);
        }
      }),

  }),
});

/**
 * The inlined shell completion function for each supported shell.
 * Self-contained — each snippet calls `just __complete` only at tab
 * time, not at shell-startup time, so shells open cleanly even if
 * `just` isn't on PATH when they launch.
 */
function renderCompletionScript(shell: 'bash' | 'zsh' | 'fish'): string {
  if (shell === 'bash') {
    return [
      '_just_complete() {',
      '  local IFS=$\'\\n\'',
      '  local cursor=$((COMP_CWORD - 1))',
      '  local -a words=("${COMP_WORDS[@]:1}")',
      '  COMPREPLY=($(just __complete "$cursor" "${words[@]}" 2>/dev/null))',
      '  return 0',
      '}',
      'complete -o default -F _just_complete just',
    ].join('\n');
  }
  if (shell === 'zsh') {
    return [
      '#compdef just',
      '_just() {',
      '  local -a completions',
      '  local cursor=$((CURRENT - 2))',
      '  completions=(${(f)"$(just __complete "$cursor" "${words[@]:1}" 2>/dev/null)"})',
      '  if (( ${#completions} )); then',
      '    compadd -a completions',
      '  fi',
      '}',
      'compdef _just just',
    ].join('\n');
  }
  return [
    'function __just_complete',
    '  set -l tokens (commandline -opc) (commandline -ct)',
    '  set -l cursor (math (count $tokens) - 2)',
    '  just __complete $cursor $tokens[2..-1] 2>/dev/null',
    'end',
    'complete -c just -f -a "(__just_complete)"',
  ].join('\n');
}
