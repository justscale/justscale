import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadEnvironment } from '../../src/index.js';

describe('loadEnvironment { from } anchoring', () => {
  let tmpRoot: string;
  let packageRoot: string;
  let nestedDir: string;
  let envDir: string;
  const corePath = new URL('../../src/index.ts', import.meta.url).href.replace('file://', '');

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'justscale-anchor-'));
    packageRoot = join(tmpRoot, 'my-pkg');
    nestedDir = join(packageRoot, 'src', 'deep', 'nested');
    envDir = join(packageRoot, 'env');

    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), '{ "name": "my-pkg" }');

    // An env file that imports createEnvironment from the *core* package by
    // absolute path, so the dynamic import resolves during this test.
    writeFileSync(
      join(envDir, 'acceptance.js'),
      `import { createEnvironment } from '${pathToFileURL(corePath).href}';\n` +
      'export default createEnvironment({ name: \'acceptance\', type: \'production\' });\n',
    );
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('walks up from anchor URL to find package.json and env/', async () => {
    // Simulate calling loadEnvironment from a nested file inside the package.
    const anchor = { url: pathToFileURL(join(nestedDir, 'main.ts')).href };

    const env = await loadEnvironment({ from: anchor, name: 'acceptance' });
    assert.strictEqual(env.name, 'acceptance');
    assert.strictEqual(env.type, 'production');
  });

  test('explicit envDir overrides from anchor', async () => {
    // The anchor points into a different package; envDir wins.
    const otherDir = mkdtempSync(join(tmpdir(), 'justscale-other-'));
    try {
      // Resolve via the package-local envDir that DOES have acceptance.js.
      const env = await loadEnvironment({
        from: { url: pathToFileURL(otherDir + '/fake.ts').href },
        envDir,
        name: 'acceptance',
      });
      assert.strictEqual(env.name, 'acceptance');
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('actionable error when anchor has no package.json above it', async () => {
    await assert.rejects(
      () => loadEnvironment({ from: { url: 'file:///nonexistent/deep/file.ts' }, name: 'x' }),
      (err: Error) => {
        assert.match(err.message, /could not find a package\.json/);
        return true;
      },
    );
  });
});
