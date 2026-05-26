/**
 * Workspace + package-manager detection for the `just` CLI.
 *
 * Regressions pinned here:
 *   - `just build`/`test` keyed monorepo mode off mere existence of a
 *     pnpm-workspace.yaml; a settings-only one (allowBuilds) is NOT a monorepo.
 *   - `just test`/`install` detected the pm globally (which('pnpm')), so on a
 *     pnpm box they ran pnpm inside an npm project and pnpm refused with
 *     "This project is configured to use npm".
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectPackageManager, isMonorepoRoot } from '../../src/cli/workspace-controller.js';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'js-pm-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('projectPackageManager', () => {
  it('reads the packageManager field first', () => {
    assert.equal(projectPackageManager(tmp({ 'package.json': '{"packageManager":"npm@10.8.1"}' })), 'npm');
    assert.equal(projectPackageManager(tmp({ 'package.json': '{"packageManager":"yarn@4.0.0"}' })), 'yarn');
    assert.equal(projectPackageManager(tmp({ 'package.json': '{"packageManager":"pnpm@10.6.3"}' })), 'pnpm');
  });

  it('falls back to a lockfile when there is no packageManager field', () => {
    assert.equal(projectPackageManager(tmp({ 'package.json': '{}', 'package-lock.json': '{}' })), 'npm');
    assert.equal(projectPackageManager(tmp({ 'package.json': '{}', 'yarn.lock': '' })), 'yarn');
    assert.equal(projectPackageManager(tmp({ 'package.json': '{}', 'pnpm-lock.yaml': '' })), 'pnpm');
  });

  it('honors the project over a globally-installed pm (npm project on a pnpm box)', () => {
    // The whole point: pnpm being installed must not override an npm project.
    assert.equal(projectPackageManager(tmp({ 'package.json': '{"packageManager":"npm@10.8.1"}' })), 'npm');
  });
});

describe('isMonorepoRoot', () => {
  it('true when a turbo.json is present', () => {
    assert.equal(isMonorepoRoot(tmp({ 'turbo.json': '{}' })), true);
  });

  it('true when pnpm-workspace.yaml declares `packages:`', () => {
    assert.equal(isMonorepoRoot(tmp({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n' })), true);
  });

  it('false for a settings-only pnpm-workspace.yaml (allowBuilds, no `packages:`)', () => {
    assert.equal(
      isMonorepoRoot(tmp({ 'pnpm-workspace.yaml': 'allowBuilds:\n  esbuild: true\n' })),
      false,
    );
  });

  it('false when neither turbo.json nor a workspace file is present', () => {
    assert.equal(isMonorepoRoot(tmp({ 'package.json': '{}' })), false);
  });
});
