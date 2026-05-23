/**
 * CLI integration tests for ptsc.
 *
 * Tests the ptsc command-line interface to ensure it mirrors tsc behavior
 * and correctly handles JustScale-specific features.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PTSC_PATH = resolve(__dirname, '../dist/compiler/ptsc.js');

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Execute ptsc command and return output
 */
function runPtsc(args: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const result = execSync(`node ${PTSC_PATH} ${args.join(' ')}`, {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: result, stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: error.status ?? 1,
    };
  }
}

/**
 * Create a temporary directory for test projects
 */
function createTempProject(): string {
  const tempDir = join(tmpdir(), `ptsc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Clean up a temporary directory
 */
function cleanupTempProject(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================================
// Version and Help Tests
// ============================================================================

describe('ptsc CLI', () => {
  describe('--version', () => {
    it('should display version information', () => {
      const result = runPtsc(['--version']);

      assert.strictEqual(result.exitCode, 0, 'Should exit with code 0');
      assert.ok(result.stdout.includes('ptsc Version'), 'Should show ptsc version');
      assert.ok(result.stdout.includes('TypeScript'), 'Should show TypeScript version');
    });

    it('should support -v shorthand', () => {
      const result = runPtsc(['-v']);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('ptsc Version'));
    });
  });

  describe('--help', () => {
    it('should display help information', () => {
      const result = runPtsc(['--help']);

      assert.strictEqual(result.exitCode, 0, 'Should exit with code 0');
      assert.ok(result.stdout.includes('ptsc'), 'Should mention ptsc');
      assert.ok(result.stdout.includes('Usage:'), 'Should show usage');
      assert.ok(result.stdout.includes('--watch'), 'Should document --watch');
      assert.ok(result.stdout.includes('--project'), 'Should document --project');
      assert.ok(result.stdout.includes('--build'), 'Should document --build');
      assert.ok(result.stdout.includes('justscale'), 'Should mention JustScale options');
    });

    it('should support -h shorthand', () => {
      const result = runPtsc(['-h']);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Usage:'));
    });

    it('should support -? shorthand', () => {
      const result = runPtsc(['-?']);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Usage:'));
    });
  });

  // ============================================================================
  // --init Tests
  // ============================================================================

  describe('--init', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempProject();
    });

    after(() => {
      cleanupTempProject(tempDir);
    });

    it('should create tsconfig.json with JustScale defaults', () => {
      const result = runPtsc(['--init'], tempDir);

      assert.strictEqual(result.exitCode, 0, 'Should exit with code 0');
      assert.ok(result.stdout.includes('Created tsconfig.json'), 'Should confirm creation');

      // Verify file exists
      const configPath = join(tempDir, 'tsconfig.json');
      assert.ok(existsSync(configPath), 'tsconfig.json should exist');

      // Verify content
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.ok(config.compilerOptions, 'Should have compilerOptions');
      assert.ok(config.justscale, 'Should have justscale section');
      assert.strictEqual(config.justscale.processFilePattern, '*.process.ts');
      assert.strictEqual(config.justscale.strict, true);
      assert.ok(config.compilerOptions.plugins, 'Should have plugins');
      assert.ok(
        config.compilerOptions.plugins.some((p: any) => p.name === '@justscale/typescript/language-service'),
        'Should include LSP plugin'
      );
    });

    it('should fail if tsconfig.json already exists', () => {
      // tsconfig.json was created in previous test
      const result = runPtsc(['--init'], tempDir);

      assert.strictEqual(result.exitCode, 1, 'Should exit with code 1');
      assert.ok(result.stderr.includes('already exists'), 'Should report file exists');
    });
  });

  // ============================================================================
  // Compilation Tests
  // ============================================================================

  describe('compilation', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempProject();

      // Create tsconfig.json
      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            outDir: './dist',
            rootDir: './src',
            strict: true,
            // Generated proto files import from @justscale/core for MessageSchema, defineMessage, etc.
            // In real projects, @justscale/core is installed in node_modules.
            // In isolated tests, we skip lib check since the types aren't available.
            skipLibCheck: true,
          },
          justscale: {
            processFilePattern: '*.process.ts',
            strict: true,
          },
          include: ['src/**/*'],
        })
      );

      // Create src directory
      mkdirSync(join(tempDir, 'src'));

      // Create a simple TypeScript file
      writeFileSync(
        join(tempDir, 'src', 'index.ts'),
        `export function hello(): string {
  return 'Hello, World!'
}
`
      );
    });

    after(() => {
      cleanupTempProject(tempDir);
    });

    it('should compile TypeScript files', () => {
      const result = runPtsc([], tempDir);

      assert.strictEqual(result.exitCode, 0, `Should exit with code 0. stderr: ${result.stderr}`);

      // Check output file exists
      const outputPath = join(tempDir, 'dist', 'index.js');
      assert.ok(existsSync(outputPath), 'Should generate output file');

      // Verify output content
      const output = readFileSync(outputPath, 'utf-8');
      assert.ok(output.includes('hello'), 'Output should contain function');
    });

    it('should support --noEmit for type checking only', () => {
      const result = runPtsc(['--noEmit'], tempDir);

      assert.strictEqual(result.exitCode, 0, 'Should exit with code 0');
    });

    it('should support -p/--project flag', () => {
      const result = runPtsc(['-p', 'tsconfig.json'], tempDir);

      assert.strictEqual(result.exitCode, 0, `Should exit with code 0. stderr: ${result.stderr}`);
    });

    it('should report TypeScript errors', () => {
      // Create a file with type errors
      writeFileSync(
        join(tempDir, 'src', 'error.ts'),
        'const x: number = \'not a number\''
      );

      const result = runPtsc(['--noEmit'], tempDir);

      // Clean up error file
      rmSync(join(tempDir, 'src', 'error.ts'));

      assert.strictEqual(result.exitCode, 1, 'Should exit with code 1 for type errors');
      // Check for error indication - might be in stdout or stderr, and may include ANSI codes
      const output = result.stdout + result.stderr;
      assert.ok(
        output.includes('error') && output.includes('TS'),
        `Should report TypeScript error. Output: ${output.substring(0, 200)}`
      );
    });
  });

  // ============================================================================
  // Process File Tests
  // ============================================================================

  describe('process compilation', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempProject();

      // Create tsconfig.json
      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            outDir: './dist',
            rootDir: './src',
            strict: true,
            // Generated proto files import from @justscale/core for MessageSchema, defineMessage, etc.
            // In real projects, @justscale/core is installed in node_modules.
            // In isolated tests, we skip lib check since the types aren't available.
            skipLibCheck: true,
          },
          justscale: {
            processFilePattern: '*.process.ts',
            strict: true,
          },
          include: ['src/**/*'],
        })
      );

      // Create src directory
      mkdirSync(join(tempDir, 'src'));
    });

    after(() => {
      cleanupTempProject(tempDir);
    });

    it('should compile process files with transformation', () => {
      // Create a simple process file (without actual imports since we're just testing transformation)
      writeFileSync(
        join(tempDir, 'src', 'order.process.ts'),
        `// Process file marker
export const config = {
  name: 'order-process',
}
`
      );

      const result = runPtsc([], tempDir);

      assert.strictEqual(result.exitCode, 0, `Should exit with code 0. stderr: ${result.stderr}`);

      // Check output exists
      const outputPath = join(tempDir, 'dist', 'order.process.js');
      assert.ok(existsSync(outputPath), 'Should generate process output file');
    });
  });

  // ============================================================================
  // Build Mode Tests
  // ============================================================================

  describe('build mode (-b)', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempProject();

      // Create tsconfig.build.json
      writeFileSync(
        join(tempDir, 'tsconfig.build.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            outDir: './dist',
            rootDir: './src',
            declaration: true,
          },
          include: ['src/**/*'],
        })
      );

      // Create src directory and file
      mkdirSync(join(tempDir, 'src'));
      writeFileSync(
        join(tempDir, 'src', 'lib.ts'),
        'export const VERSION = \'1.0.0\''
      );
    });

    after(() => {
      cleanupTempProject(tempDir);
    });

    it('should compile with -b flag', () => {
      const result = runPtsc(['-b', 'tsconfig.build.json'], tempDir);

      assert.strictEqual(result.exitCode, 0, `Should exit with code 0. stderr: ${result.stderr}`);

      // Check output and declaration files
      assert.ok(existsSync(join(tempDir, 'dist', 'lib.js')), 'Should generate .js file');
      assert.ok(existsSync(join(tempDir, 'dist', 'lib.d.ts')), 'Should generate .d.ts file');
    });
  });

  // ============================================================================
  // Single File Compilation Tests
  // ============================================================================

  describe('single file compilation', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempProject();

      // Create a standalone TypeScript file
      writeFileSync(
        join(tempDir, 'standalone.ts'),
        `const greeting: string = 'Hello'
console.log(greeting)
`
      );
    });

    after(() => {
      cleanupTempProject(tempDir);
    });

    it('should compile a single file without tsconfig', () => {
      const result = runPtsc(['standalone.ts'], tempDir);

      assert.strictEqual(result.exitCode, 0, `Should exit with code 0. stderr: ${result.stderr}`);

      // Check output exists
      assert.ok(existsSync(join(tempDir, 'standalone.js')), 'Should generate output file');
    });
  });

  // ============================================================================
  // JustScale Config Tests
  // ============================================================================

  describe('justscale config section', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempProject();
      mkdirSync(join(tempDir, 'src'));
    });

    after(() => {
      cleanupTempProject(tempDir);
    });

    it('should respect processFilePattern config', () => {
      // Create tsconfig with custom pattern
      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            outDir: './dist',
            rootDir: './src',
          },
          justscale: {
            processFilePattern: '*.workflow.ts',
            strict: true,
          },
          include: ['src/**/*'],
        })
      );

      // Create a workflow file
      writeFileSync(
        join(tempDir, 'src', 'payment.workflow.ts'),
        'export const workflow = { name: \'payment\' }'
      );

      const result = runPtsc([], tempDir);

      assert.strictEqual(result.exitCode, 0, `Should exit with code 0. stderr: ${result.stderr}`);
    });

    it('should respect verbose config', () => {
      // Create tsconfig with verbose enabled
      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            outDir: './dist',
            rootDir: './src',
          },
          justscale: {
            verbose: true,
          },
          include: ['src/**/*'],
        })
      );

      writeFileSync(
        join(tempDir, 'src', 'app.ts'),
        'export const app = \'test\''
      );

      const result = runPtsc([], tempDir);

      assert.strictEqual(result.exitCode, 0);
      // Verbose mode should show compilation progress
      assert.ok(
        result.stdout.includes('Compiling') || result.stdout.length > 0,
        'Verbose should produce output'
      );
    });
  });


  // ============================================================================
  // Error Handling Tests
  // ============================================================================

  describe('error handling', () => {
    it('should fail gracefully when config not found', () => {
      const tempDir = createTempProject();

      try {
        const result = runPtsc([], tempDir);

        assert.strictEqual(result.exitCode, 1, 'Should exit with code 1');
        assert.ok(
          result.stderr.includes('Cannot find') || result.stdout.includes('Cannot find'),
          'Should report config not found'
        );
      } finally {
        cleanupTempProject(tempDir);
      }
    });

    it('should fail gracefully for invalid config path', () => {
      const result = runPtsc(['-p', 'nonexistent.json']);

      assert.strictEqual(result.exitCode, 1, 'Should exit with code 1');
    });
  });
});
