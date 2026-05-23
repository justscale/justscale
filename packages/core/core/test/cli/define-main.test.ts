import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { defineMain } from '../../src/index.js';

describe('defineMain', () => {
  test('does not run when module is imported', async () => {
    // Simulating "imported" means meta.url !== process.argv[1]. We construct
    // a meta object whose URL differs from the currently-running script.
    let ran = false;
    defineMain({ url: 'file:///some/other/path.ts' }, () => { ran = true; });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(ran, false);
  });

  test('runs when meta.url matches process.argv[1]', async () => {
    // process.argv[1] during this test is the test runner's entry; we fake
    // a meta whose URL resolves to that path.
    const argv1 = process.argv[1];
    if (!argv1) {
      // node --test may set argv[1] empty in some setups
      return;
    }
    const metaUrl = pathToFileURL(argv1).href;

    let ran = false;
    defineMain({ url: metaUrl }, () => { ran = true; });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(ran, true);
  });

  test('re-throws errors via unhandled-rejection path', async () => {
    // Spawn a child node process that uses defineMain to throw — verify
    // the process exits non-zero.
    const tmpDir = mkdtempSync(join(tmpdir(), 'justscale-main-'));
    try {
      const entry = join(tmpDir, 'entry.mjs');
      const corePath = new URL('../../dist/index.js', import.meta.url).href.replace('file://', '');
      writeFileSync(
        entry,
        `import { defineMain } from '${pathToFileURL(corePath).href}';\n` +
        'defineMain(import.meta, async () => { throw new Error(\'BOOM\'); });\n',
      );

      const result = spawnSync(process.execPath, [entry], { encoding: 'utf-8' });
      assert.notStrictEqual(result.status, 0, 'expected non-zero exit');
      assert.match(result.stderr, /BOOM/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
