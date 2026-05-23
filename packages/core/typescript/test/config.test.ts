/**
 * Configuration parsing tests.
 *
 * Tests the JustScale configuration system including:
 * - tsconfig.json parsing with justscale section
 * - Default configuration values
 * - Configuration validation
 * - Configuration merging
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseConfig,
  findConfig,
  defaultConfig,
  mergeConfig,
  isProcessFile,
  type JustScaleConfig,
} from '../src/config/index.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createTempDir(): string {
  const tempDir = join(tmpdir(), `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
// Default Config Tests
// ============================================================================

describe('Configuration', () => {
  describe('defaultConfig', () => {
    it('should have correct default values', () => {
      assert.strictEqual(defaultConfig.processFilePattern, '*.process.ts');
      assert.strictEqual(defaultConfig.strict, true);
      assert.strictEqual(defaultConfig.verbose, false);
      assert.strictEqual(defaultConfig.sourceMap, true);
      assert.deepStrictEqual(defaultConfig.plugins, []);
      assert.deepStrictEqual(defaultConfig.paths, {});
      assert.deepStrictEqual(defaultConfig.processModules, ['@justscale/core/process']);
    });

    it('should be a complete config object', () => {
      // Ensure all properties are defined
      assert.ok('processFilePattern' in defaultConfig);
      assert.ok('strict' in defaultConfig);
      assert.ok('verbose' in defaultConfig);
      assert.ok('sourceMap' in defaultConfig);
      assert.ok('plugins' in defaultConfig);
      assert.ok('paths' in defaultConfig);
      assert.ok('processModules' in defaultConfig);
    });
  });

  // ============================================================================
  // parseConfig Tests
  // ============================================================================

  describe('parseConfig', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempDir();
    });

    after(() => {
      cleanupTempDir(tempDir);
    });

    it('should parse basic tsconfig.json', () => {
      const configPath = join(tempDir, 'basic-tsconfig.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            outDir: './dist',
          },
          // Use files array instead of include to avoid "no inputs found" error
          files: [],
        })
      );

      const result = parseConfig(configPath);

      assert.ok(result, 'Should return result');
      // Filter out TS18002/TS18003 (empty files/no inputs) which is expected for this test
      const realErrors = result.errors.filter(e => e.code !== 18003 && e.code !== 18002);
      assert.deepStrictEqual(realErrors, [], 'Should have no real errors');
      assert.ok(result.compilerOptions, 'Should have compilerOptions');
      assert.ok(result.justscale, 'Should have justscale config');
    });

    it('should parse justscale section', () => {
      const configPath = join(tempDir, 'justscale-tsconfig.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
          },
          justscale: {
            processFilePattern: '*.workflow.ts',
            strict: false,
            verbose: true,
          },
          files: [],
        })
      );

      const result = parseConfig(configPath);

      // Filter out TS18002/TS18003 which is expected
      const realErrors = result.errors.filter(e => e.code !== 18003 && e.code !== 18002);
      assert.deepStrictEqual(realErrors, [], 'Should have no real errors');
      assert.strictEqual(result.justscale.processFilePattern, '*.workflow.ts');
      assert.strictEqual(result.justscale.strict, false);
      assert.strictEqual(result.justscale.verbose, true);
    });

    it('should merge justscale section with defaults', () => {
      const configPath = join(tempDir, 'partial-justscale.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
          },
          justscale: {
            verbose: true,
          },
        })
      );

      const result = parseConfig(configPath);

      // Should have verbose from config
      assert.strictEqual(result.justscale.verbose, true);
      // Should have defaults for other properties
      assert.strictEqual(result.justscale.strict, defaultConfig.strict);
      assert.strictEqual(result.justscale.processFilePattern, defaultConfig.processFilePattern);
    });

    it('should parse processModules', () => {
      const configPath = join(tempDir, 'modules-tsconfig.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
          },
          justscale: {
            processModules: ['@myorg/process', '@myorg/workflow'],
          },
          files: [],
        })
      );

      const result = parseConfig(configPath);

      // Filter out TS18002/TS18003 which is expected
      const realErrors = result.errors.filter(e => e.code !== 18003 && e.code !== 18002);
      assert.deepStrictEqual(realErrors, [], 'Should have no real errors');
      // Should include both default and custom modules
      assert.ok(result.justscale.processModules?.includes('@justscale/core/process'));
      assert.ok(result.justscale.processModules?.includes('@myorg/process'));
      assert.ok(result.justscale.processModules?.includes('@myorg/workflow'));
    });

    it('should parse plugins', () => {
      const configPath = join(tempDir, 'plugins-tsconfig.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
          },
          justscale: {
            plugins: [
              './my-plugin.js',
              { name: '@myorg/plugin', options: { debug: true } },
            ],
          },
          files: [],
        })
      );

      const result = parseConfig(configPath);

      // Filter out TS18002/TS18003 which is expected
      const realErrors = result.errors.filter(e => e.code !== 18003 && e.code !== 18002);
      assert.deepStrictEqual(realErrors, [], 'Should have no real errors');
      assert.strictEqual(result.justscale.plugins?.length, 2);
      assert.strictEqual(result.justscale.plugins?.[0], './my-plugin.js');
      assert.deepStrictEqual(result.justscale.plugins?.[1], {
        name: '@myorg/plugin',
        options: { debug: true },
      });
    });

    it('should report errors for invalid processFilePattern type', () => {
      const configPath = join(tempDir, 'invalid-pattern.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
          },
          justscale: {
            processFilePattern: 123, // Invalid: should be string
          },
        })
      );

      const result = parseConfig(configPath);

      assert.ok(result.errors.length > 0, 'Should have errors');
      assert.ok(
        result.errors.some((e) => {
          const msg = typeof e.messageText === 'string' ? e.messageText : e.messageText.messageText;
          return msg.includes('processFilePattern');
        }),
        'Should mention processFilePattern'
      );
    });

    it('should report errors for invalid strict type', () => {
      const configPath = join(tempDir, 'invalid-strict.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
          },
          justscale: {
            strict: 'yes', // Invalid: should be boolean
          },
        })
      );

      const result = parseConfig(configPath);

      assert.ok(result.errors.length > 0, 'Should have errors');
      assert.ok(
        result.errors.some((e) => {
          const msg = typeof e.messageText === 'string' ? e.messageText : e.messageText.messageText;
          return msg.includes('strict');
        }),
        'Should mention strict'
      );
    });

    it('should report errors for invalid plugins array', () => {
      const configPath = join(tempDir, 'invalid-plugins.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
          },
          justscale: {
            plugins: 'not-an-array', // Invalid: should be array
          },
        })
      );

      const result = parseConfig(configPath);

      assert.ok(result.errors.length > 0, 'Should have errors');
    });

    it('should handle missing config file', () => {
      const configPath = join(tempDir, 'nonexistent.json');

      const result = parseConfig(configPath);

      assert.ok(result.errors.length > 0, 'Should have errors for missing file');
    });
  });

  // ============================================================================
  // findConfig Tests
  // ============================================================================

  describe('findConfig', () => {
    let tempDir: string;

    before(() => {
      tempDir = createTempDir();
    });

    after(() => {
      cleanupTempDir(tempDir);
    });

    it('should find tsconfig.json in directory', () => {
      const projectDir = join(tempDir, 'find-project');
      mkdirSync(projectDir);
      writeFileSync(
        join(projectDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022' },
        })
      );

      const result = findConfig(projectDir);

      assert.ok(result, 'Should find config');
      assert.ok(result.configFilePath.endsWith('tsconfig.json'));
    });

    it('should return undefined when no config exists', () => {
      const emptyDir = join(tempDir, 'empty-project');
      mkdirSync(emptyDir);

      const result = findConfig(emptyDir);

      assert.strictEqual(result, undefined, 'Should return undefined');
    });
  });

  // ============================================================================
  // mergeConfig Tests
  // ============================================================================

  describe('mergeConfig', () => {
    it('should merge two configs', () => {
      const base: JustScaleConfig = {
        processFilePattern: '*.process.ts',
        strict: true,
        verbose: false,
        plugins: ['plugin-a'],
        processModules: ['@justscale/core/process'],
      };

      const override: Partial<JustScaleConfig> = {
        verbose: true,
        plugins: ['plugin-b'],
      };

      const result = mergeConfig(base, override);

      assert.strictEqual(result.processFilePattern, '*.process.ts', 'Should keep base pattern');
      assert.strictEqual(result.strict, true, 'Should keep base strict');
      assert.strictEqual(result.verbose, true, 'Should override verbose');
      // Plugins should be combined
      assert.ok(result.plugins?.includes('plugin-a'), 'Should keep base plugin');
      assert.ok(result.plugins?.includes('plugin-b'), 'Should add override plugin');
    });

    it('should deduplicate processModules', () => {
      const base: JustScaleConfig = {
        processModules: ['@justscale/core/process', '@myorg/process'],
      };

      const override: Partial<JustScaleConfig> = {
        processModules: ['@justscale/core/process', '@myorg/workflow'],
      };

      const result = mergeConfig(base, override);

      // Should have unique modules only
      const uniqueModules = [...new Set(result.processModules)];
      assert.strictEqual(result.processModules?.length, uniqueModules.length);
      assert.ok(result.processModules?.includes('@justscale/core/process'));
      assert.ok(result.processModules?.includes('@myorg/process'));
      assert.ok(result.processModules?.includes('@myorg/workflow'));
    });

    it('should merge paths objects', () => {
      const base: JustScaleConfig = {
        paths: {
          '@app/*': ['src/*'],
        },
      };

      const override: Partial<JustScaleConfig> = {
        paths: {
          '@lib/*': ['lib/*'],
        },
      };

      const result = mergeConfig(base, override);

      assert.deepStrictEqual(result.paths?.['@app/*'], ['src/*']);
      assert.deepStrictEqual(result.paths?.['@lib/*'], ['lib/*']);
    });
  });

  // ============================================================================
  // isProcessFile Tests
  // ============================================================================

  describe('isProcessFile', () => {
    it('should match default pattern', () => {
      assert.ok(isProcessFile('order.process.ts'));
      assert.ok(isProcessFile('/path/to/order.process.ts'));
      assert.ok(isProcessFile('src/workflows/payment.process.ts'));
    });

    it('should not match non-process files', () => {
      assert.ok(!isProcessFile('order.ts'));
      assert.ok(!isProcessFile('order.service.ts'));
      assert.ok(!isProcessFile('process.ts')); // Doesn't have dot before process
    });

    it('should use custom pattern', () => {
      const config: JustScaleConfig = {
        processFilePattern: '*.workflow.ts',
      };

      assert.ok(isProcessFile('payment.workflow.ts', config));
      assert.ok(!isProcessFile('payment.process.ts', config));
    });
  });
});
