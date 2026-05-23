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
}

export function scaffoldProject(options: ScaffoldOptions): string[] {
  const { projectDir, projectName, system, coreVersion = '^0.1.0' } = options;
  const generated: string[] = [];

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, 'src'), { recursive: true });

  // package.json
  writeFile(projectDir, 'package.json', JSON.stringify({
    name: projectName,
    version: '0.1.0',
    type: 'module',
    scripts: {
      build: 'just build',
      test: 'just test',
      dev: 'just dev',
    },
    dependencies: {
      '@justscale/core': coreVersion,
    },
    devDependencies: {
      '@justscale/typescript': coreVersion,
      'tsx': '^4.0.0',
    },
  }, null, 2) + '\n', generated);

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
  modes: {
    serve: () => import('./src/serve.js'),
    cli: () => import('./src/cli.js'),
  },
  build: {
    outDir: './dist',
  },
})
`, generated);

  // src/app.ts
  writeFile(projectDir, 'src/app.ts', `import JustScale from '@justscale/core'

export const app = JustScale()
  // Add services, features, and adapters here
  // .add(PostgresClient)
  // .add(AuthFeature)
`, generated);

  // src/serve.ts
  writeFile(projectDir, 'src/serve.ts', `import { app } from './app.js'

// HTTP mode - add controllers and start listening
export default app
  // .add(AuthEndpointsFeature)
  // .add(ApiController)
  .build()
`, generated);

  // src/cli.ts
  writeFile(projectDir, 'src/cli.ts', `import { app } from './app.js'

// CLI mode - add custom CLI controllers
// Package CLI commands (user add, pg migrate, etc.) are auto-discovered
export default app
  .build()
`, generated);

  // .gitignore
  writeFile(projectDir, '.gitignore', `node_modules/
dist/
.justscale/
*.tsbuildinfo
`, generated);

  // IDE config
  if (system.ides.includes('jetbrains')) {
    generateJetBrainsConfig(projectDir, generated);
  }
  if (system.ides.includes('vscode') || system.ides.includes('cursor')) {
    generateVSCodeConfig(projectDir, generated);
  }

  // AI config
  if (system.aiTools.includes('claude')) {
    generateClaudeConfig(projectDir, projectName, generated);
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

function generateClaudeConfig(projectDir: string, projectName: string, generated: string[]): void {
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
- \`/new-process\` — scaffold a durable process (signals + handler) with
  the framework's distributed-safety rules baked in.
- \`/audit-domain-purity\` — static check for ID leaks, infra imports
  from domain, hand-edited migrations, missing \`Locked<T>\`.
- \`/multi-instance-test\` — scaffold a two-instance e2e test that
  proves a behavior holds across nodes (the canonical JustScale test
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
