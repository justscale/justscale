/**
 * Installer security regressions.
 *
 * The installer touches the user's filesystem before they have a chance
 * to inspect anything. Two attack shapes that have to fail closed:
 *
 *   1. A pre-planted symlink in the target dir would let a write
 *      escape into ~/.ssh/authorized_keys (or anywhere else).
 *   2. A compromised template package whose readdirSync returns
 *      `..` or `foo/bar` would let `join(skillsDir, name, ...)`
 *      escape the intended .claude/skills/ destination.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafePathSegment, scaffoldProject } from '../src/scaffold.js';

describe('isSafePathSegment', () => {
  it('rejects empty string', () => {
    assert.strictEqual(isSafePathSegment(''), false);
  });

  it('rejects . and ..', () => {
    assert.strictEqual(isSafePathSegment('.'), false);
    assert.strictEqual(isSafePathSegment('..'), false);
  });

  it('rejects forward slash (POSIX path separator)', () => {
    assert.strictEqual(isSafePathSegment('foo/bar'), false);
    assert.strictEqual(isSafePathSegment('/etc/passwd'), false);
  });

  it('rejects backslash (Windows path separator)', () => {
    assert.strictEqual(isSafePathSegment('foo\\bar'), false);
    assert.strictEqual(isSafePathSegment('..\\etc'), false);
  });

  it('rejects NUL byte', () => {
    assert.strictEqual(isSafePathSegment('foo\0bar'), false);
  });

  it('accepts normal skill names', () => {
    assert.strictEqual(isSafePathSegment('justscale-concepts'), true);
    assert.strictEqual(isSafePathSegment('justscale-new-process'), true);
    assert.strictEqual(isSafePathSegment('my_skill_123'), true);
  });

  it('accepts hidden-prefixed names that are not bare dots', () => {
    // We only block . and .. specifically, not all dot-prefixed names.
    // .skill is a valid (if unusual) directory name.
    assert.strictEqual(isSafePathSegment('.skill'), true);
  });
});

describe('scaffoldProject — symlink refusal', () => {
  it('throws if a symlink already exists at a target write path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'just-scaffold-sec-'));
    const target = mkdtempSync(join(tmpdir(), 'just-scaffold-sec-link-target-'));
    try {
      // Plant a symlink at where the scaffolder would write package.json.
      // If the security guard is missing, scaffoldProject would call
      // writeFileSync which (per Node fs semantics) follows the link and
      // overwrites the target file.
      mkdirSync(tmp, { recursive: true });
      const linkTarget = join(target, 'sensitive');
      writeFileSync(linkTarget, 'do-not-overwrite');
      symlinkSync(linkTarget, join(tmp, 'package.json'));

      assert.throws(
        () =>
          scaffoldProject({
            projectDir: tmp,
            projectName: 'test-app',
            system: {
              os: 'linux',
              arch: 'x64',
              nodeVersion: 'v24.0.0',
              packageManager: 'pnpm',
              ides: [],
              aiTools: [],
              gitHosting: null,
            },
          }),
        /Refusing to overwrite symlink/,
      );

      // Critical: the link target's CONTENT must be unchanged.
      assert.strictEqual(readFileSync(linkTarget, 'utf8'), 'do-not-overwrite');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('writes normally when no symlinks are present', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'just-scaffold-ok-'));
    try {
      const generated = scaffoldProject({
        projectDir: tmp,
        projectName: 'test-app',
        system: {
          os: 'linux',
          arch: 'x64',
          nodeVersion: 'v24.0.0',
          packageManager: 'pnpm',
          ides: [],
          aiTools: [],
          gitHosting: null,
        },
      });
      assert.ok(generated.length > 0, 'should generate files');
      assert.ok(existsSync(join(tmp, 'package.json')), 'package.json should exist');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
