/**
 * Tests for discoverPackageCommands: walks dependencies/devDependencies,
 * reads each package's justscale.modes.cli, imports the referenced module,
 * and collects any exports that look like controllers (have `factory` +
 * `deps`). This is the exact flow that surfaces `@justscale/auth`'s
 * AuthCliController to the `just` binary.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverPackageCommands } from '../discovery.js';

describe('discoverPackageCommands', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'js-cli-discovery-'));

    // Consumer project: declares a dependency on `fake-plugin`.
    writeFileSync(
      join(workDir, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        version: '0.0.0',
        type: 'module',
        dependencies: { 'fake-plugin': '0.0.0' },
      }),
    );

    // Fake dependency in node_modules/fake-plugin:
    //   - package.json advertises justscale.modes.cli (source + import)
    //   - dist/cli.js exports an object shaped like a createController result
    const pluginDir = join(workDir, 'node_modules', 'fake-plugin');
    mkdirSync(join(pluginDir, 'dist'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'fake-plugin',
        version: '0.0.0',
        type: 'module',
        justscale: {
          modes: {
            cli: {
              source: './src/cli.ts',
              import: './dist/cli.js',
            },
          },
        },
      }),
    );
    // The exported controller mimics the shape createController() returns:
    // a plain object with `factory` (fn) and `deps` (record). That's what
    // isControllerExport() in discovery.ts checks for.
    writeFileSync(
      join(pluginDir, 'dist', 'cli.js'),
      `export const FakeCliController = {
         factory: async () => ({ prefix: '', settings: {}, routes: [], deps: {} }),
         deps: {},
         prefix: '',
         settings: { command: 'fake' },
       };
       // Non-controller export; must be filtered out.
       export const notAController = { foo: 'bar' };
      `,
    );

    process.chdir(workDir);
  });

  after(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('picks up controllers contributed via justscale.modes.cli', async () => {
    const controllers = await discoverPackageCommands();
    assert.equal(controllers.length, 1, 'expected exactly one controller export');
    const [c] = controllers;
    assert.equal(typeof c.factory, 'function');
    assert.ok('deps' in c);
    assert.equal(c.settings.command, 'fake');
  });

  it('returns empty array when no package.json is present', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'js-cli-discovery-empty-'));
    const prev = process.cwd();
    try {
      process.chdir(empty);
      const controllers = await discoverPackageCommands();
      assert.deepEqual(controllers, []);
    } finally {
      process.chdir(prev);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
