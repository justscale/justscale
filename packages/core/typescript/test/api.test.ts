/**
 * Programmatic API tests.
 *
 * Tests the transpile(), transpileProject(), and createProgram() functions
 * that provide programmatic access to the JustScale TypeScript compiler.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import {
  transpile,
  transpileProject,
  createProgram,
  getProcessDiagnostics,
  formatDiagnostics,
  type TranspileResult,
  type TranspileProjectResult,
} from '../src/api.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createTempDir(): string {
  const tempDir = join(tmpdir(), `api-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================================
// transpile() Tests
// ============================================================================

describe('Programmatic API', () => {
  describe('transpile()', () => {
    it('should transpile simple TypeScript code', () => {
      const source = `
        export function hello(name: string): string {
          return \`Hello, \${name}!\`
        }
      `;

      const result = transpile(source, 'test.ts');

      assert.ok(result, 'Should return result');
      assert.ok(result.success, 'Should succeed');
      assert.ok(result.code, 'Should produce code');
      assert.ok(result.code.includes('hello'), 'Output should include function');
      assert.ok(result.code.includes('Hello'), 'Output should include string');
      assert.deepStrictEqual(result.diagnostics, [], 'Should have no diagnostics');
    });

    it('should return type errors in diagnostics', () => {
      const source = `
        const x: number = 'not a number'
      `;

      const result = transpile(source, 'test.ts');

      assert.ok(!result.success, 'Should not succeed');
      assert.ok(result.diagnostics.length > 0, 'Should have diagnostics');
      assert.ok(
        result.diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error),
        'Should have error diagnostic'
      );
    });

    it('should generate source maps when requested', () => {
      const source = 'export const x = 42';

      const result = transpile(source, 'test.ts', { sourceMap: true });

      assert.ok(result.success);
      assert.ok(result.sourceMap, 'Should include source map');
      assert.ok(result.sourceMap.includes('mappings'), 'Source map should have mappings');
    });

    it('should generate declarations when requested', () => {
      const source = 'export function add(a: number, b: number): number { return a + b }';

      const result = transpile(source, 'test.ts', { declaration: true });

      assert.ok(result.success);
      assert.ok(result.declaration, 'Should include declaration');
      assert.ok(result.declaration.includes('declare'), 'Declaration should have declare keyword');
      assert.ok(result.declaration.includes('add'), 'Declaration should include function name');
    });

    it('should use custom compiler options', () => {
      const source = 'export const x = 42';

      const result = transpile(source, 'test.ts', {
        compilerOptions: {
          target: ts.ScriptTarget.ES5,
        },
      });

      assert.ok(result.success);
      // ES5 output should use var instead of const
      assert.ok(
        result.code.includes('var') || result.code.includes('exports'),
        'Should use ES5 syntax'
      );
    });

    it('should recognize process files by extension', () => {
      const source = `
        export const myProcess = {
          name: 'test',
        }
      `;

      // Using .process.ts extension should trigger process detection
      const result = transpile(source, 'test.process.ts');

      // Should produce code even for process files (may have type diagnostics from isolated module)
      assert.ok(result.code !== undefined, 'Should produce code');
      // No process-specific diagnostics since there's no createProcess call
      // Filter out TS1208 (isolated modules) which is expected
      const realErrors = result.diagnostics.filter(
        d => d.category === 1 && d.code !== 1208
      );
      assert.strictEqual(realErrors.length, 0, 'Should have no real errors');
    });

    it('should handle empty input', () => {
      const result = transpile('', 'empty.ts');

      assert.ok(result.success);
      assert.ok(result.code !== undefined, 'Should return code (possibly empty)');
    });

    it('should handle syntax errors', () => {
      const source = `
        function broken( {
          // Missing closing paren
        }
      `;

      const result = transpile(source, 'broken.ts');

      assert.ok(!result.success, 'Should not succeed');
      assert.ok(result.diagnostics.length > 0, 'Should have syntax error');
    });
  });

  // ============================================================================
  // transpileProject() Tests
  // ============================================================================

  describe('transpileProject()', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempDir();
    });

    after(() => {
      cleanupTempDir(tempDir);
    });

    it('should transpile a project', () => {
      // Create project structure
      const projectDir = join(tempDir, 'project1');
      mkdirSync(join(projectDir, 'src'), { recursive: true });

      writeFileSync(
        join(projectDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            outDir: './dist',
            rootDir: './src',
          },
          include: ['src/**/*'],
        })
      );

      writeFileSync(
        join(projectDir, 'src', 'index.ts'),
        'export const greeting = \'Hello\''
      );

      writeFileSync(
        join(projectDir, 'src', 'utils.ts'),
        'export function double(n: number): number { return n * 2 }'
      );

      const result = transpileProject(join(projectDir, 'tsconfig.json'));

      assert.ok(result, 'Should return result');
      assert.ok(result.success, 'Should succeed');
      assert.ok(result.files.size >= 2, 'Should have multiple files');
      assert.deepStrictEqual(result.diagnostics, [], 'Should have no diagnostics');
    });

    it('should report project-wide type errors', () => {
      const projectDir = join(tempDir, 'project2');
      mkdirSync(join(projectDir, 'src'), { recursive: true });

      writeFileSync(
        join(projectDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
          },
          include: ['src/**/*'],
        })
      );

      // Create file with type error
      writeFileSync(
        join(projectDir, 'src', 'error.ts'),
        'const x: number = \'string\''
      );

      const result = transpileProject(join(projectDir, 'tsconfig.json'));

      assert.ok(!result.success, 'Should not succeed');
      assert.ok(result.diagnostics.length > 0, 'Should have diagnostics');
    });

    it('should respect justscale config', () => {
      const projectDir = join(tempDir, 'project3');
      mkdirSync(join(projectDir, 'src'), { recursive: true });

      writeFileSync(
        join(projectDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
          },
          justscale: {
            verbose: true,
            processFilePattern: '*.workflow.ts',
          },
          include: ['src/**/*'],
        })
      );

      writeFileSync(
        join(projectDir, 'src', 'app.ts'),
        'export const app = \'test\''
      );

      const result = transpileProject(join(projectDir, 'tsconfig.json'));

      assert.ok(result.success);
    });

    it('should allow overriding options', () => {
      const projectDir = join(tempDir, 'project4');
      mkdirSync(join(projectDir, 'src'), { recursive: true });

      writeFileSync(
        join(projectDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2015',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
          },
          include: ['src/**/*'],
        })
      );

      writeFileSync(
        join(projectDir, 'src', 'app.ts'),
        'export const x = 1'
      );

      const result = transpileProject(join(projectDir, 'tsconfig.json'), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
        },
      });

      // Check for success - may have isolated modules warning which is ok
      const errors = result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
      assert.strictEqual(errors.length, 0, 'Should have no errors');
    });
  });

  // ============================================================================
  // createProgram() Tests
  // ============================================================================

  describe('createProgram()', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempDir();
    });

    after(() => {
      cleanupTempDir(tempDir);
    });

    it('should create a TypeScript program', () => {
      const filePath = join(tempDir, 'test.ts');
      writeFileSync(filePath, 'export const x = 42');

      const program = createProgram([filePath]);

      assert.ok(program, 'Should return program');
      assert.ok(program.getSourceFiles().length > 0, 'Should have source files');
    });

    it('should allow custom compiler options', () => {
      const filePath = join(tempDir, 'custom.ts');
      writeFileSync(filePath, 'export const y = \'hello\'');

      const program = createProgram([filePath], {
        target: ts.ScriptTarget.ES5,
        strict: true,
      });

      const options = program.getCompilerOptions();
      assert.strictEqual(options.target, ts.ScriptTarget.ES5);
      assert.strictEqual(options.strict, true);
    });

    it('should use sensible defaults', () => {
      const filePath = join(tempDir, 'defaults.ts');
      writeFileSync(filePath, 'export const z = true');

      const program = createProgram([filePath]);

      const options = program.getCompilerOptions();
      assert.strictEqual(options.target, ts.ScriptTarget.ES2022);
      assert.strictEqual(options.module, ts.ModuleKind.NodeNext);
    });
  });

  // ============================================================================
  // getProcessDiagnostics() Tests
  // ============================================================================

  describe('getProcessDiagnostics()', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempDir();
    });

    after(() => {
      cleanupTempDir(tempDir);
    });

    it('should return empty array for non-process files', () => {
      const filePath = join(tempDir, 'regular.ts');
      writeFileSync(filePath, 'export const x = 1');

      const program = createProgram([filePath]);
      const diagnostics = getProcessDiagnostics(program);

      assert.deepStrictEqual(diagnostics, []);
    });

    it('should detect process files by extension', () => {
      const filePath = join(tempDir, 'my.process.ts');
      writeFileSync(
        filePath,
        `
        export const process = {
          name: 'test'
        }
      `
      );

      const program = createProgram([filePath]);
      const diagnostics = getProcessDiagnostics(program);

      // No createProcess call, so no diagnostics
      assert.deepStrictEqual(diagnostics, []);
    });
  });

  // ============================================================================
  // formatDiagnostics() Tests
  // ============================================================================

  describe('formatDiagnostics()', () => {
    it('should format diagnostics for console output', () => {
      const diagnostics: ts.Diagnostic[] = [
        {
          category: ts.DiagnosticCategory.Error,
          code: 2322,
          file: undefined,
          start: undefined,
          length: undefined,
          messageText: 'Type error message',
        },
      ];

      const output = formatDiagnostics(diagnostics);

      assert.ok(typeof output === 'string', 'Should return string');
      assert.ok(output.includes('error'), 'Should include error');
    });

    it('should handle empty diagnostics array', () => {
      const output = formatDiagnostics([]);

      assert.strictEqual(output, '', 'Should return empty string for no diagnostics');
    });
  });

  // ============================================================================
  // Integration Tests
  // ============================================================================

  describe('integration', () => {
    it('should work with ES modules', () => {
      const source = `
        export const add = (a: number, b: number) => a + b
        export const multiply = (a: number, b: number) => a * b
      `;

      const result = transpile(source, 'math.ts', {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
        },
      });

      assert.ok(result.success);
      assert.ok(result.code.includes('export'));
    });

    it('should handle async functions with Promise type', () => {
      const source = `
        export async function fetchData(): Promise<string> {
          return 'data'
        }
      `;

      const result = transpile(source, 'async.ts');

      assert.ok(result.success, 'Should compile successfully');
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');
      assert.ok(result.code.includes('async'), 'Should preserve async keyword');
    });

    it('should handle classes', () => {
      const source = `
        export class MyService {
          private name: string

          constructor(name: string) {
            this.name = name
          }

          getName(): string {
            return this.name
          }
        }
      `;

      const result = transpile(source, 'service.ts');

      assert.ok(result.success);
      assert.ok(result.code.includes('class'));
      assert.ok(result.code.includes('MyService'));
    });

    it('should handle generics', () => {
      const source = `
        export function identity<T>(value: T): T {
          return value
        }
      `;

      const result = transpile(source, 'generics.ts');

      assert.ok(result.success);
      assert.ok(result.code.includes('identity'));
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle very long source files', () => {
      // Generate a large file with many functions
      const functions = Array.from({ length: 100 }, (_, i) =>
        `export function func${i}() { return ${i} }`
      ).join('\n');

      const result = transpile(functions, 'large.ts');

      assert.ok(result.code !== undefined);
      assert.ok(result.code.includes('func99'));
    });

    it('should handle unicode identifiers', () => {
      const source = `
        export const 变量 = '中文'
        export const αβγ = 'Greek'
        export const emoji🎉 = 'party'
      `;

      const result = transpile(source, 'unicode.ts');

      // Just check it doesn't crash - unicode handling depends on target
      assert.ok(result.code !== undefined);
    });

    it('should handle deeply nested code', () => {
      const source = `
        export function deep() {
          if (true) {
            if (true) {
              if (true) {
                if (true) {
                  if (true) {
                    return 'deep'
                  }
                }
              }
            }
          }
          return 'shallow'
        }
      `;

      const result = transpile(source, 'deep.ts');

      assert.ok(result.code !== undefined);
      assert.ok(result.code.includes('deep'));
    });

    it('should handle code with comments', () => {
      const source = `
        /**
         * JSDoc comment
         */
        export function documented(): void {
          // Line comment
          const x = 1 /* inline comment */
        }
      `;

      const result = transpile(source, 'comments.ts');

      assert.ok(result.code !== undefined);
      assert.ok(result.code.includes('documented'));
    });

    it('should handle code with string templates', () => {
      const source = `
        export function greet(name: string): string {
          return \`Hello, \${name}!\`
        }
      `;

      const result = transpile(source, 'templates.ts');

      assert.ok(result.code !== undefined);
      assert.ok(result.code.includes('Hello'));
    });

    it('should handle code with multiple type annotations', () => {
      const source = `
        export type MyType = {
          a: string
          b: number
          c: boolean
        }

        export interface MyInterface {
          method(): void
        }

        export const obj: MyType = {
          a: 'a',
          b: 1,
          c: true
        }
      `;

      const result = transpile(source, 'types.ts');

      assert.ok(result.code !== undefined);
    });

    it('should handle enum declarations', () => {
      const source = `
        export enum Color {
          Red = 'red',
          Green = 'green',
          Blue = 'blue'
        }
      `;

      const result = transpile(source, 'enum.ts');

      assert.ok(result.code !== undefined);
      assert.ok(result.code.includes('Color'));
    });

    it('should handle rest parameters', () => {
      const source = `
        export function sum(...numbers: number[]): number {
          return numbers.reduce((a, b) => a + b, 0)
        }
      `;

      const result = transpile(source, 'rest.ts');

      assert.ok(result.code !== undefined);
      assert.ok(result.code.includes('sum'));
    });

    it('should handle destructuring', () => {
      const source = `
        export function destruct({ a, b }: { a: number, b: number }) {
          return a + b
        }
      `;

      const result = transpile(source, 'destruct.ts');

      assert.ok(result.code !== undefined);
      assert.ok(result.code.includes('destruct'));
    });

    it('should handle optional chaining', () => {
      const source = `
        export function safe(obj: { nested?: { value?: string } }) {
          return obj?.nested?.value ?? 'default'
        }
      `;

      const result = transpile(source, 'optional.ts');

      assert.ok(result.code !== undefined);
    });
  });
});
