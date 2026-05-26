/**
 * Scaffold output regressions.
 *
 * The generated project has to actually run `just dev / build / test`. Each
 * assertion here pins a bug we shipped and then fixed, so they can't come
 * back silently:
 *
 *   - config used `modes:` instead of `app:`  -> `just dev` found no entry
 *   - a `pnpm-workspace.yaml` with no `packages:` is settings-only, but if it
 *     ever grows a `packages:` key the app reads as a monorepo and `just
 *     build`/`test` route to turbo and fail
 *   - missing `typecheck` script -> `just test` (which runs it first) failed
 *   - missing `@types/node` / `types: [node]` -> typecheck couldn't find
 *     node globals or node:test
 *   - the toolchain must be pinned (`packageManager`) or pnpm errors
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemInfo } from '../src/detect.js';
import { scaffoldProject } from '../src/scaffold.js';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sys(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    os: 'macos',
    arch: 'arm64',
    nodeVersion: 'v24.0.0',
    packageManager: 'pnpm',
    packageManagerVersion: '10.0.0',
    ides: [],
    aiTools: [],
    gitHosting: null,
    hasDirenv: false,
    ...overrides,
  };
}

interface Scaffolded {
  files: string[];
  read: (rel: string) => string;
  json: (rel: string) => any;
  has: (rel: string) => boolean;
}

function scaffold(system: SystemInfo = sys()): Scaffolded {
  const dir = mkdtempSync(join(tmpdir(), 'js-scaffold-out-'));
  dirs.push(dir);
  const files = scaffoldProject({ projectDir: dir, projectName: 'demo', system });
  return {
    files,
    read: (rel) => readFileSync(join(dir, rel), 'utf8'),
    json: (rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8')),
    has: (rel) => existsSync(join(dir, rel)),
  };
}

describe('justscale.config.ts', () => {
  it('declares `app:` (defineProject app entry), not the legacy `modes:`', () => {
    const cfg = scaffold().read('justscale.config.ts');
    assert.match(cfg, /app:\s*\(\)\s*=>\s*import\('\.\/src\/app\.js'\)/);
    assert.doesNotMatch(cfg, /\bmodes\s*:/);
  });
});

describe('package.json', () => {
  it('has dev/build/test/typecheck scripts (typecheck is required by `just test`)', () => {
    const pkg = scaffold().json('package.json');
    assert.deepEqual(Object.keys(pkg.scripts).sort(), ['build', 'dev', 'test', 'typecheck']);
    assert.equal(pkg.scripts.typecheck, 'ptsc --noEmit');
    assert.equal(pkg.scripts.dev, 'just dev');
  });

  it('depends on core + http, and dev-depends on hmr/typescript/@types-node/tsx', () => {
    const pkg = scaffold().json('package.json');
    assert.ok(pkg.dependencies['@justscale/core'], 'core');
    assert.ok(pkg.dependencies['@justscale/http'], 'http');
    assert.ok(pkg.devDependencies['@justscale/hmr'], 'hmr (just dev imports it)');
    assert.ok(pkg.devDependencies['@justscale/typescript'], 'typescript');
    assert.ok(pkg.devDependencies['@types/node'], '@types/node (typecheck needs node globals)');
    assert.ok(pkg.devDependencies['tsx'], 'tsx');
  });

  it('pins packageManager from the detected version', () => {
    const pkg = scaffold(sys({ packageManager: 'pnpm', packageManagerVersion: '10.6.3' })).json('package.json');
    assert.equal(pkg.packageManager, 'pnpm@10.6.3');
  });

  it('omits packageManager when the version is undetectable', () => {
    const pkg = scaffold(sys({ packageManagerVersion: '' })).json('package.json');
    assert.equal(pkg.packageManager, undefined);
  });
});

describe('pnpm-workspace.yaml (pnpm build-approval, NOT a monorepo)', () => {
  it('pre-approves esbuild + cbor-extract builds', () => {
    const ws = scaffold(sys({ packageManager: 'pnpm' })).read('pnpm-workspace.yaml');
    assert.match(ws, /allowBuilds:/);
    assert.match(ws, /onlyBuiltDependencies:/);
    assert.match(ws, /esbuild/);
    assert.match(ws, /cbor-extract/);
  });

  it('does NOT declare `packages:` — else `just build`/`test` mis-route to turbo', () => {
    const ws = scaffold(sys({ packageManager: 'pnpm' })).read('pnpm-workspace.yaml');
    assert.doesNotMatch(ws, /^packages\s*:/m);
  });

  it('is only written for pnpm (npm/yarn run build scripts by default)', () => {
    assert.equal(scaffold(sys({ packageManager: 'npm' })).has('pnpm-workspace.yaml'), false);
    assert.equal(scaffold(sys({ packageManager: 'yarn' })).has('pnpm-workspace.yaml'), false);
  });
});

describe('env/', () => {
  it('generates development/test/production, each providing HttpConfig', () => {
    const s = scaffold();
    for (const name of ['development', 'test', 'production']) {
      assert.ok(s.has(`env/${name}.ts`), `env/${name}.ts`);
      const env = s.read(`env/${name}.ts`);
      assert.match(env, /HttpConfig/);
      assert.match(env, new RegExp(`name:\\s*'${name}'`));
      assert.match(env, /createEnvironment/);
    }
  });
});

describe('source + test', () => {
  it('app entry uses defineApp and imports the service from its own module', () => {
    const s = scaffold();
    const app = s.read('src/app.ts');
    assert.match(app, /defineApp\(import\.meta/);
    assert.match(app, /from '\.\/greeting\.service\.js'/);
  });

  it('GreetingService lives in its own exported file', () => {
    const s = scaffold();
    assert.ok(s.has('src/greeting.service.ts'));
    assert.match(s.read('src/greeting.service.ts'), /export class GreetingService/);
  });

  it('ships a runnable starter test', () => {
    const s = scaffold();
    assert.ok(s.has('test/greeting.test.ts'));
    assert.match(s.read('test/greeting.test.ts'), /GreetingService/);
  });
});

describe('tsconfig.json', () => {
  it('sets types: ["node"] and includes src', () => {
    const tsc = scaffold().json('tsconfig.json');
    assert.deepEqual(tsc.compilerOptions.types, ['node']);
    assert.ok(tsc.include.includes('src'));
  });
});

describe('docs + direnv', () => {
  it('generates a human README', () => {
    assert.ok(scaffold().has('README.md'));
  });

  it('writes .envrc only when direnv is present, and gitignores .direnv/', () => {
    assert.equal(scaffold(sys({ hasDirenv: false })).has('.envrc'), false);

    const withDirenv = scaffold(sys({ hasDirenv: true }));
    assert.ok(withDirenv.has('.envrc'));
    assert.match(withDirenv.read('.envrc'), /PATH_add node_modules\/\.bin/);
    assert.match(withDirenv.read('.gitignore'), /\.direnv\//);
  });
});
