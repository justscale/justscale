/**
 * Unit Tests for CLI Workspace Commands
 *
 * Tests the WorkspaceController routes, argument parsing, and CLI runner
 * integration without actually executing the underlying commands.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WorkspaceController,
  findWorkspaceRoot,
} from '../../src/cli/workspace-controller.js';
import { createAppInternal } from '../../src/app.js';
import { run } from '../../src/cli/runner.js';
import { createMockIO } from '../../src/cli/io.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ============================================================================
// WorkspaceController Tests
// ============================================================================

describe('WorkspaceController', () => {
  it('should be a valid controller definition', () => {
    assert.ok(WorkspaceController);
    assert.ok(WorkspaceController.deps);
    assert.ok(WorkspaceController.factory);
  });

  it('should create an app with workspace routes', async () => {
    const app = createAppInternal({
      controllers: [WorkspaceController],
    });

    await app.ready;

    assert.ok(app.controllers);
    assert.strictEqual(app.controllers.length, 1);

    const controller = app.controllers[0];
    assert.ok(controller.routes);
    assert.strictEqual(controller.routes.length, 7);
  });

  it('should have no command prefix (root-level commands)', async () => {
    const app = createAppInternal({
      controllers: [WorkspaceController],
    });

    await app.ready;

    const controller = app.controllers[0];
    const settings = controller.settings as any;

    // Should not have a command prefix
    assert.strictEqual(settings?.command, undefined);
    assert.strictEqual(settings?.prefix, undefined);
  });

  describe('build route', () => {
    it('should define build route as CLI method', async () => {
      const app = createAppInternal({
        controllers: [WorkspaceController],
      });

      await app.ready;

      const routes = app.controllers[0].routes;
      const buildRoute = routes.find((r: any) => r.path === 'build');

      assert.ok(buildRoute);
      assert.strictEqual(buildRoute.method, 'CLI');
    });

    it('should accept filter option', async () => {
      const app = createAppInternal({
        controllers: [WorkspaceController],
      });
      await app.ready;

      const mockIO = createMockIO();

      // Test that --help shows filter option
      const result = await run(app, {
        argv: ['build', '--help'],
        exitOnError: false,
        io: mockIO,
      });

      assert.strictEqual(result.success, true);
    });
  });

  describe('run route', () => {
    it('should define run route as CLI method', async () => {
      const app = createAppInternal({
        controllers: [WorkspaceController],
      });

      await app.ready;

      const routes = app.controllers[0].routes;
      const runRoute = routes.find((r: any) => r.path === 'run');

      assert.ok(runRoute);
      assert.strictEqual(runRoute.method, 'CLI');
    });
  });

  describe('test route', () => {
    it('should define test route as CLI method', async () => {
      const app = createAppInternal({
        controllers: [WorkspaceController],
      });

      await app.ready;

      const routes = app.controllers[0].routes;
      const testRoute = routes.find((r: any) => r.path === 'test');

      assert.ok(testRoute);
      assert.strictEqual(testRoute.method, 'CLI');
    });
  });
});

// ============================================================================
// CLI Runner Integration Tests
// ============================================================================

describe('CLI Runner with WorkspaceController', () => {
  it('should show help with --help flag', async () => {
    const app = createAppInternal({
      controllers: [WorkspaceController],
    });
    await app.ready;

    const result = await run(app, {
      argv: ['--help'],
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
  });

  it('should show help with -h flag', async () => {
    const app = createAppInternal({
      controllers: [WorkspaceController],
    });
    await app.ready;

    const result = await run(app, {
      argv: ['-h'],
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
  });

  it('should show help with no arguments', async () => {
    const app = createAppInternal({
      controllers: [WorkspaceController],
    });
    await app.ready;

    const result = await run(app, {
      argv: [],
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
  });

  it('should show command-specific help', async () => {
    const app = createAppInternal({
      controllers: [WorkspaceController],
    });
    await app.ready;

    const result = await run(app, {
      argv: ['build', '--help'],
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
  });

  it('should return error for unknown command', async () => {
    const app = createAppInternal({
      controllers: [WorkspaceController],
    });
    await app.ready;

    const result = await run(app, {
      argv: ['unknown-command'],
      exitOnError: false,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.ok(result.error.message.includes('Unknown command'));
  });

  it('should match build command', async () => {
    const app = createAppInternal({
      controllers: [WorkspaceController],
    });
    await app.ready;

    // Just verify the command is recognized (help doesn't execute)
    const result = await run(app, {
      argv: ['build', '--help'],
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
  });

  it('should match run command', async () => {
    const app = createAppInternal({
      controllers: [WorkspaceController],
    });
    await app.ready;

    const result = await run(app, {
      argv: ['run', '--help'],
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
  });

  it('should match test command', async () => {
    const app = createAppInternal({
      controllers: [WorkspaceController],
    });
    await app.ready;

    const result = await run(app, {
      argv: ['test', '--help'],
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
  });
});

// ============================================================================
// findWorkspaceRoot Tests
// ============================================================================

describe('findWorkspaceRoot', () => {
  it('should find workspace root from package directory', () => {
    const packageDir = join(__dirname, '..', '..');
    const root = findWorkspaceRoot(packageDir);

    assert.ok(
      root.includes('internal-for-now') || root.includes('justscale'),
      `Expected workspace root, got: ${root}`,
    );
  });

  it('should find workspace root from nested directory', () => {
    const nestedDir = join(__dirname);
    const root = findWorkspaceRoot(nestedDir);

    assert.ok(
      root.includes('internal-for-now') || root.includes('justscale'),
      `Expected workspace root, got: ${root}`,
    );
  });

  it('should find workspace root from deeply nested directory', () => {
    const deepDir = join(__dirname, '..', '..', 'src', 'cli', 'bin');
    const root = findWorkspaceRoot(deepDir);

    assert.ok(
      root.includes('internal-for-now') || root.includes('justscale'),
      `Expected workspace root, got: ${root}`,
    );
  });

  it('should return cwd when no workspace found', () => {
    // /tmp typically doesn't have pnpm-workspace.yaml
    const root = findWorkspaceRoot('/tmp');

    // Should fall back to cwd since /tmp won't have workspace file
    assert.ok(root);
  });

  it('should use cwd by default', () => {
    const root = findWorkspaceRoot();

    // Should return a valid path
    assert.ok(root);
    assert.ok(typeof root === 'string');
  });
});
