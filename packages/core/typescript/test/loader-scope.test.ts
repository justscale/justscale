/**
 * Loader project-root scoping.
 *
 * The process loader compiles `*.process.ts` (or any TS importing
 * `@justscale/core/process` + `createProcess`) with our transformer,
 * which emits process-runtime opcodes. That codegen path is for trusted
 * project source — running it on a hostile path that resolves outside
 * the project (via symlink or absolute import) would let attacker code
 * piggyback on the runtime.
 *
 * `_isInsideRoot` is the gate. These tests pin it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _isInsideRoot } from '../src/loader/loader.js';

describe('_isInsideRoot', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'loader-scope-root-'));
    outside = mkdtempSync(join(tmpdir(), 'loader-scope-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('accepts a regular file inside the root', () => {
    const f = join(root, 'app.process.ts');
    writeFileSync(f, '// process');
    assert.strictEqual(_isInsideRoot(f, root), true);
  });

  it('accepts a regular file in a subdirectory of the root', () => {
    mkdirSync(join(root, 'src', 'processes'), { recursive: true });
    const f = join(root, 'src', 'processes', 'order.process.ts');
    writeFileSync(f, '// process');
    assert.strictEqual(_isInsideRoot(f, root), true);
  });

  it('rejects a file that lives literally outside the root', () => {
    const f = join(outside, 'evil.process.ts');
    writeFileSync(f, '// hostile');
    assert.strictEqual(_isInsideRoot(f, root), false);
  });

  it('rejects a symlink whose target is outside the root', () => {
    // The classic threat: a project file `pwned.process.ts` is actually a
    // symlink pointing at /tmp/evil.process.ts. Without realpath
    // resolution, the loader sees an in-root path and compiles attacker
    // source.
    const target = join(outside, 'evil.process.ts');
    writeFileSync(target, '// hostile');
    const linkPath = join(root, 'pwned.process.ts');
    symlinkSync(target, linkPath);
    assert.strictEqual(_isInsideRoot(linkPath, root), false);
  });

  it('accepts a symlink whose target is inside the root', () => {
    // Legitimate use of in-root symlinks (monorepo workspace links etc).
    const target = join(root, 'real.process.ts');
    writeFileSync(target, '// process');
    const linkPath = join(root, 'alias.process.ts');
    symlinkSync(target, linkPath);
    assert.strictEqual(_isInsideRoot(linkPath, root), true);
  });

  it('returns false on stat errors (non-existent path)', () => {
    // Conservative: anything we can't stat is treated as out-of-root so
    // it falls through to the safer non-process compile path.
    assert.strictEqual(_isInsideRoot(join(root, 'does-not-exist.ts'), root), false);
  });
});
