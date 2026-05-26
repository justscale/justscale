import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SystemInfo } from './detect.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Skills shipped with the installer live under packages/misc/install/templates/skills/
// (single source of truth - repo root .claude/skills/ symlinks here). At runtime
// this resolves to <package>/templates/skills/ in the published install.
const SKILLS_TEMPLATE_DIR = join(__dirname, '..', 'templates', 'skills');

export interface ScaffoldOptions {
  projectDir: string
  projectName: string
  system: SystemInfo
  coreVersion?: string
  typescriptVersion?: string
  hmrVersion?: string
  httpVersion?: string
}

export function scaffoldProject(options: ScaffoldOptions): string[] {
  const {
    projectDir,
    projectName,
    system,
    coreVersion = '^0.1.0',
    typescriptVersion = '^0.1.0',
    hmrVersion = '^0.1.0',
    httpVersion = '^0.1.0',
  } = options;
  const generated: string[] = [];

  // `just` is a LOCAL dependency (node_modules/.bin/just), not a global
  // command — so bare `just dev` only works if node_modules/.bin is on PATH.
  // Document the form that runs the local bin through the package manager.
  // (npm has no `npm <bin>` fallback, so use npx there.)
  const just = system.packageManager === 'npm' ? 'npx just' : `${system.packageManager} just`;

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, 'src'), { recursive: true });

  // package.json
  const pkg: Record<string, unknown> = {
    name: projectName,
    version: '0.1.0',
    type: 'module',
  };
  // Pin the package manager. corepack reads this; without it pnpm errors with
  // "Missing `packageManager` field". Uses the version detected on this machine.
  if (system.packageManagerVersion) {
    pkg.packageManager = `${system.packageManager}@${system.packageManagerVersion}`;
  }
  pkg.scripts = {
    build: 'just build',
    test: 'just test',
    dev: 'just dev',
  };
  pkg.dependencies = {
    '@justscale/core': coreVersion,
    '@justscale/http': httpVersion,
  };
  // @justscale/hmr is dev-only — `just dev` spawns the app with
  // `--import @justscale/hmr/register`, so it must be installed or dev mode
  // fails with ERR_MODULE_NOT_FOUND. The kernel dynamic-imports it only when
  // NODE_ENV=development, never in production.
  pkg.devDependencies = {
    '@justscale/hmr': hmrVersion,
    '@justscale/typescript': typescriptVersion,
    'tsx': '^4.0.0',
  };
  writeFile(projectDir, 'package.json', JSON.stringify(pkg, null, 2) + '\n', generated);

  // pnpm-workspace.yaml — pre-approve dependency build scripts.
  //
  // pnpm gates dependency build scripts by default; without this, `pnpm install`
  // fails with ERR_PNPM_IGNORED_BUILDS (a non-zero exit). A JustScale project
  // pulls in two that need building: esbuild (via tsx) and cbor-extract (the
  // native CBOR accelerator behind @justscale/core's cbor-x). Both keys are
  // emitted for cross-version support — pnpm 11+ reads `allowBuilds`, pnpm 10
  // reads `onlyBuiltDependencies`; each ignores the other. (npm/yarn run build
  // scripts by default, so this file is only written for pnpm.)
  if (system.packageManager === 'pnpm') {
    writeFile(projectDir, 'pnpm-workspace.yaml', `allowBuilds:
  esbuild: true
  cbor-extract: true
onlyBuiltDependencies:
  - esbuild
  - cbor-extract
`, generated);
  }

  // tsconfig.json
  writeFile(projectDir, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: 'src',
      declaration: true,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['src'],
  }, null, 2) + '\n', generated);

  // justscale.config.ts
  writeFile(projectDir, 'justscale.config.ts', `import { defineProject } from '@justscale/core'

export default defineProject({
  // The app entry. \`just dev\` runs it with hot reload; \`just build\` bundles
  // it. Split per environment with { default, development, ... } when needed.
  app: () => import('./src/app.js'),
  build: {
    outDir: './dist',
  },
})
`, generated);

  // src/app.ts — the app entry. defineApp() makes it both runnable
  // (\`just dev\` and \`node dist/app.js\` boot + serve it) and importable
  // (the CLI and tests call the exported factory).
  writeFile(projectDir, 'src/app.ts', `import JustScale, { createController, defineApp, defineService } from '@justscale/core'
import { Get } from '@justscale/http'

// A service holds your domain logic — storage-agnostic and injectable.
class GreetingService extends defineService({
  inject: {},
  factory: () => ({
    greet: (name: string) => \`Hello, \${name}!\`,
  }),
}) {}

// A controller exposes services over a transport (here, HTTP).
const ApiController = createController({
  inject: { greeting: GreetingService },
  routes: ({ greeting }) => ({
    hello: Get('/').handle((ctx) => ctx.res.json({ message: greeting.greet('JustScale') })),
  }),
})

// defineApp wires it together. Run directly (\`just dev\`, \`node dist/app.js\`)
// it builds + serves; imported by the CLI/tests it returns the builder.
// \`.add(env)\` pulls in the active environment's providers — the HTTP port and
// any other env-specific config — from env/<name>.ts.
export default defineApp(import.meta, (env) =>
  JustScale()
    .add(env)
    .add(GreetingService)
    .add(ApiController),
)
`, generated);

  // env/<name>.ts — per-environment providers. \`just dev\` loads
  // env/development.ts (NODE_ENV=development); \`just test\` loads env/test.ts;
  // a production run loads env/production.ts. Each supplies the HTTP port (and
  // is where you'd wire a real database, secrets, etc.).
  const envFile = (name: string, type: string, port: string): string =>
    `import { createConfig, createEnvironment, type EnvContract } from '@justscale/core'
import { HttpConfig } from '@justscale/http'

export type AppEnv = EnvContract<{ config: readonly [typeof HttpConfig] }>

const Http = createConfig({
  provides: [HttpConfig],
  factory: () => ({
    [HttpConfig.key]: { port: Number(process.env.PORT ?? ${port}), host: '0.0.0.0' },
  }),
})

export default createEnvironment<AppEnv>({
  name: '${name}',
  type: '${type}',
  providers: [Http],
})
`;
  writeFile(projectDir, 'env/development.ts', envFile('development', 'development', '3000'), generated);
  writeFile(projectDir, 'env/test.ts', envFile('test', 'test', '0'), generated);
  writeFile(projectDir, 'env/production.ts', envFile('production', 'production', '8080'), generated);

  // .gitignore
  writeFile(projectDir, '.gitignore', `node_modules/
dist/
.justscale/
.direnv/
*.tsbuildinfo
`, generated);

  // .envrc — only when direnv is installed. Puts the project's local bins
  // (just, tsc, eslint, ...) on PATH whenever you cd in, so they work bare in
  // any shell — the same thing IDE terminals do automatically. Needs a one-off
  // `direnv allow`. Skipped when direnv isn't present so non-users don't get a
  // confusing inert file.
  if (system.hasDirenv) {
    writeFile(projectDir, '.envrc', `# Put the project's local binaries (just, tsc, ...) on PATH so they work
# bare in this directory. Run \`direnv allow\` once to enable.
PATH_add node_modules/.bin
`, generated);
  }

  // IDE config
  if (system.ides.includes('jetbrains')) {
    generateJetBrainsConfig(projectDir, generated);
  }
  if (system.ides.includes('vscode') || system.ides.includes('cursor')) {
    generateVSCodeConfig(projectDir, generated);
  }

  // AI config
  if (system.aiTools.includes('claude')) {
    generateClaudeConfig(projectDir, projectName, just, system.packageManager, generated);
  }

  // CI/CD
  if (system.gitHosting === 'github') {
    generateGitHubActions(projectDir, system.packageManager, generated);
  } else if (system.gitHosting === 'gitlab') {
    generateGitLabCI(projectDir, system.packageManager, generated);
  }

  return generated;
}

function writeFile(dir: string, relativePath: string, content: string, generated: string[]): void {
  const fullPath = join(dir, relativePath);
  const parentDir = join(fullPath, '..');
  if (parentDir !== dir) mkdirSync(parentDir, { recursive: true });

  // Refuse to follow symlinks. Without this check, an attacker (or a
  // hostile pre-existing target dir) could plant a symlink at e.g.
  // `package.json -> ~/.ssh/authorized_keys`, and the scaffold would
  // happily clobber the link target with our generated content.
  // lstatSync resolves the link itself (not the target).
  if (existsSync(fullPath)) {
    const st = lstatSync(fullPath);
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to overwrite symlink at ${relativePath} (would write to the link target outside the project directory).`,
      );
    }
  }

  writeFileSync(fullPath, content);
  generated.push(relativePath);
}

function generateJetBrainsConfig(projectDir: string, generated: string[]): void {
  const ideaDir = join(projectDir, '.idea');
  mkdirSync(ideaDir, { recursive: true });

  writeFile(projectDir, '.idea/typescript.xml', `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="TypeScriptCompilerConfiguration">
    <option name="useService" value="true" />
    <option name="typeScriptServiceDirectory" value="$PROJECT_DIR$/node_modules/@justscale/typescript" />
    <option name="versionType" value="SERVICE_DIRECTORY" />
  </component>
</project>
`, generated);

  const runConfigDir = join(ideaDir, 'runConfigurations');
  mkdirSync(runConfigDir, { recursive: true });

  for (const [name, cmd] of [['just_dev', 'dev'], ['just_build', 'build'], ['just_test', 'test']] as const) {
    writeFile(projectDir, `.idea/runConfigurations/${name}.xml`, `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="just ${cmd}" type="js.build_tools.npm">
    <package-json value="$PROJECT_DIR$/package.json" />
    <command value="run" />
    <scripts>
      <script value="${cmd}" />
    </scripts>
    <node-interpreter value="project" />
    <envs />
    <method v="2" />
  </configuration>
</component>
`, generated);
  }
}

function generateVSCodeConfig(projectDir: string, generated: string[]): void {
  writeFile(projectDir, '.vscode/settings.json', JSON.stringify({
    'typescript.tsdk': './node_modules/@justscale/typescript/lib',
    'typescript.enablePromptUseWorkspaceTsdk': true,
  }, null, 2) + '\n', generated);

  writeFile(projectDir, '.vscode/launch.json', JSON.stringify({
    version: '0.2.0',
    configurations: [{
      type: 'node',
      request: 'launch',
      name: 'just dev',
      runtimeExecutable: 'npx',
      runtimeArgs: ['just', 'dev'],
      cwd: '${workspaceFolder}',
      console: 'integratedTerminal',
    }],
  }, null, 2) + '\n', generated);
}

function generateClaudeConfig(projectDir: string, projectName: string, just: string, pm: string, generated: string[]): void {
  writeFile(projectDir, '.claude/settings.json', JSON.stringify({
    mcpServers: {
      justscale: {
        command: './node_modules/.bin/just',
        args: ['mcp', 'serve'],
      },
    },
  }, null, 2) + '\n', generated);

  writeFile(projectDir, 'CLAUDE.md', `# ${projectName}

## Commands

The \`just\` CLI ships with \`@justscale/core\`. For a bare \`just\` command (like
\`tsc\`) install it globally once — \`npm i -g @justscale/core\` — or run it
project-local as \`${just} <cmd>\` (\`${pm} run build\` / \`dev\` / \`test\` also work).

\`\`\`bash
just build              # Build the project
just test               # Run tests
just dev                # Development mode with hot reload
just init               # Re-run project setup
just install <package>  # Install a JustScale plugin
\`\`\`

## Architecture

This project uses JustScale — a TypeScript framework with:
- Custom TypeScript compiler (\`ptsc\`) for durable process compilation
- Dependency injection with compile-time validation
- CLI commands discoverable from installed packages
- Mode-based entry points defined in \`justscale.config.ts\`

## Conventions

- ESM everywhere (\`"type": "module"\`)
- 2-space indent, single quotes, semicolons
- Tests: \`node:test\` runner via \`tsx --test\`

## Claude Code skills

The installer scaffolded a set of JustScale-aware Claude Code skills under
\`.claude/skills/\`. Each one encodes a recurring framework rule as an
executable workflow or a load-on-demand reference. Invoke them from inside
Claude Code:

- \`/justscale-concepts\` — orientation: the four core principles
  (durable processes, ID-free domain, type-states, distributed-first)
  and the canonical project layout. Auto-loads when starting work on
  this codebase.
- \`/justscale-new-process\` — scaffold a durable process (signals +
  handler) with the framework's distributed-safety rules baked in.
- \`/justscale-audit-domain-purity\` — static check for ID leaks, infra
  imports from domain, hand-edited migrations, missing \`Locked<T>\`.
- \`/justscale-multi-instance-test\` — scaffold a two-instance e2e test
  that proves a behavior holds across nodes (the canonical JustScale test
  shape for distributed primitives).

Edit them in place — they're yours now.
`, generated);

  // JustScale-aware Claude Code skills, scaffolded into the user's
  // project so every dev gets the framework's rules as one-shot tools.
  // Templates live alongside the install package; symlinked from the repo
  // root .claude/skills/ for our own dev workflow.
  copyJustScaleSkills(projectDir, generated);
}

/**
 * Defense-in-depth against a compromised template package: returns false
 * for any entry whose name contains path separators, parent traversal, or
 * is a hidden-dot reference. readdirSync should never return such names on
 * a real filesystem, but if a malicious npm package or symlink injects one,
 * a naive `join(dir, name, ...)` would escape the intended destination.
 *
 * Exported for unit-testing.
 */
export function isSafePathSegment(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  // Reject NUL just to be paranoid — fs APIs would throw anyway, but better
  // explicit refusal than implementation-dependent behavior.
  if (name.includes('\0')) return false;
  return true;
}

function copyJustScaleSkills(projectDir: string, generated: string[]): void {
  if (!existsSync(SKILLS_TEMPLATE_DIR)) {
    // Skills directory is optional - older installs ship without it.
    return;
  }
  for (const name of readdirSync(SKILLS_TEMPLATE_DIR)) {
    if (!isSafePathSegment(name)) continue;
    const src = join(SKILLS_TEMPLATE_DIR, name, 'SKILL.md');
    if (!existsSync(src)) continue;
    const body = readFileSync(src, 'utf8');
    writeFile(projectDir, `.claude/skills/${name}/SKILL.md`, body, generated);
  }
}


function generateGitHubActions(projectDir: string, pm: string, generated: string[]): void {
  const setupStep = pm === 'pnpm'
    ? '      - uses: pnpm/action-setup@v4\n'
    : '';
  const cache = pm === 'pnpm' ? 'pnpm' : pm === 'yarn' ? 'yarn' : 'npm';

  writeFile(projectDir, '.github/workflows/ci.yml', `name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setupStep}      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: ${cache}
      - run: ${pm} install
      - run: ${pm} run build
      - run: ${pm} run test
`, generated);
}

function generateGitLabCI(projectDir: string, pm: string, generated: string[]): void {
  const enablePm = pm === 'pnpm' ? '    - corepack enable\n' : '';

  writeFile(projectDir, '.gitlab-ci.yml', `image: node:22

stages:
  - build
  - test

build:
  stage: build
  script:
${enablePm}    - ${pm} install
    - ${pm} run build

test:
  stage: test
  script:
${enablePm}    - ${pm} install
    - ${pm} run build
    - ${pm} run test
`, generated);
}
