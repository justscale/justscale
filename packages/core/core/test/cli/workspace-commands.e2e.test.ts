/**
 * E2E Tests for CLI Workspace Commands
 *
 * These tests spawn the actual just CLI process and verify
 * the commands work correctly end-to-end.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKSPACE_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const CLI_BIN = join(WORKSPACE_ROOT, 'node_modules', '.bin', 'just');

/**
 * Run the just CLI and capture output.
 */
function runCli(
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const cwd = options.cwd ?? WORKSPACE_ROOT;
    const timeout = options.timeout ?? 30000;

    const proc = spawn(CLI_BIN, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr, exitCode: 124 }); // timeout exit code
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

// ============================================================================
// CLI Help Tests
// ============================================================================

describe('E2E: justscale CLI', () => {
  it('should show help with --help', async () => {
    const { stdout, exitCode } = await runCli(['--help']);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Usage:'));
    assert.ok(stdout.includes('Commands:'));
    assert.ok(stdout.includes('build'));
    assert.ok(stdout.includes('run'));
    assert.ok(stdout.includes('test'));
  });

  it('should show help with -h', async () => {
    const { stdout, exitCode } = await runCli(['-h']);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Usage:'));
    assert.ok(stdout.includes('Commands:'));
  });

  it('should show help with no arguments', async () => {
    const { stdout, exitCode } = await runCli([]);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Usage:'));
  });

  it('should return error for unknown command', async () => {
    const { stderr, exitCode } = await runCli(['unknown-command']);

    assert.strictEqual(exitCode, 1);
    assert.ok(stderr.includes('Unknown command'));
  });
});

// ============================================================================
// Build Command Tests
// ============================================================================

describe('E2E: justscale build', () => {
  it('should show build help', async () => {
    const { stdout, stderr, exitCode } = await runCli(['build', '--help']);

    if (exitCode !== 0) {
      throw new Error(
        `Expected exit 0, got ${exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    assert.ok(stdout.includes('build'));
    assert.ok(stdout.includes('--filter'));
    assert.ok(stdout.includes('--watch'));
    assert.ok(stdout.includes('--verbose'));
  });

  it('should run build command successfully', { timeout: 60000 }, async () => {
    // Run build with a filter to make it faster
    const { exitCode } = await runCli(
      ['build', '--filter', '@justscale/testing'],
      { timeout: 60000 },
    );

    // Build should succeed (exit code 0)
    assert.strictEqual(exitCode, 0);
  });
});

// ============================================================================
// Run Command Tests
// ============================================================================

describe('E2E: justscale run', () => {
  it('should show run help', async () => {
    const { stdout, exitCode } = await runCli(['run', '--help']);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('run'));
    assert.ok(stdout.includes('--verbose'));
  });

  it('should run a TypeScript file', { timeout: 60000 }, async () => {
    // Create a temp file to run
    const tempDir = mkdtempSync(join(tmpdir(), 'justscale-test-'));
    const testFile = join(tempDir, 'test-script.ts');

    try {
      writeFileSync(testFile, 'console.log("hello from test script")');

      const { stdout, exitCode } = await runCli(['run', testFile], {
        timeout: 30000,
      });

      assert.strictEqual(exitCode, 0);
      assert.ok(stdout.includes('hello from test script'));
    } finally {
      // Cleanup
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should run a root package.json script', { timeout: 60000 }, async () => {
    // lint is a script defined in root package.json that should be fast
    const { stdout, stderr, exitCode } = await runCli(['run', 'lint'], {
      timeout: 60000,
    });

    // lint should succeed (or at least run - exit 0 means success)
    // We just verify the command was recognized and executed
    assert.ok(
      exitCode === 0 || stdout.includes('Checked') || stderr.includes('biome') || stdout.includes('eslint') || stderr.includes('eslint'),
      `Expected lint to run, got exit code ${exitCode}`,
    );
  });

  it('should error when target not found', async () => {
    const { stderr, exitCode } = await runCli(['run', 'nonexistent-file.ts'], {
      timeout: 10000,
    });

    assert.strictEqual(exitCode, 1);
  });
});

// ============================================================================
// Test Command Tests
// ============================================================================

describe('E2E: justscale test', () => {
  it('should show test help', async () => {
    const { stdout, exitCode } = await runCli(['test', '--help']);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('test'));
    assert.ok(stdout.includes('--filter'));
    assert.ok(stdout.includes('--skip-typecheck'));
    assert.ok(stdout.includes('--watch'));
    assert.ok(stdout.includes('--verbose'));
  });

  it('should run tests for a single package', async () => {
    // Run tests for channel package (fast, no external deps)
    const { exitCode } = await runCli(
      ['test', '--filter', '@justscale/testing', '--skip-typecheck'],
      { timeout: 60000 },
    );

    assert.strictEqual(exitCode, 0);
  });
});

// ============================================================================
// Command Merging Tests (with app)
// ============================================================================

describe('E2E: Command Merging', () => {
  let tempDir: string;

  before(() => {
    // Create a temp directory with a mock app
    tempDir = mkdtempSync(join(tmpdir(), 'justscale-app-test-'));

    // Create a minimal app file
    const appContent = `
import { JustScale, createController, Cli } from '@justscale/core'
import { z } from 'zod'

const TestController = createController({
  command: 'app',
  inject: {},
  routes: () => ({
    hello: Cli('hello')
      .input(z.object({}))
      .handle(async (ctx) => {
        ctx.io.log('Hello from app!')
      }),
  }),
})

export const app = JustScale()
  .add(TestController)
  .build()
`;
    writeFileSync(join(tempDir, 'app.ts'), appContent);

    // Create package.json
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        type: 'module',
        dependencies: {
          '@justscale/core': 'workspace:*',
          zod: '*',
        },
      }),
    );
  });

  it('should still show built-in commands when app exists', async () => {
    const { stdout, exitCode } = await runCli(['--help'], { cwd: tempDir });

    // Built-in commands should still be present
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('build'));
    assert.ok(stdout.includes('run'));
    assert.ok(stdout.includes('test'));
  });
});
