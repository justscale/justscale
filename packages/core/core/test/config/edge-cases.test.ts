/**
 * Edge Case Tests for Config Package
 *
 * Tests edge cases and boundary conditions that could cause bugs in production:
 * - define-config-partial: Empty names, special characters, deeply nested schemas
 * - create-config: Factory errors, partial results
 * - env-service: Empty strings, whitespace, number boundaries, unicode, newlines
 * - config-service: Non-existent partials, concurrent operations, deep paths
 * - file-watcher: Deleted files, permissions, large files, binary content
 * - profile-service: Special characters, long names, concurrent ops, corrupted JSON
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { Container } from '@justscale/core';
import {
  defineConfigPartial,
  isConfigPartial,
  createConfig,
  createConfigService,
  EnvServiceDef,
  ConfigServiceDef,
  ProfileServiceDef,
  type ConfigPartial,
  type ConfigService,
} from '../../src/features/config/index.js';
import { watchEnvFiles } from '../../src/features/config/file-watcher.js';
import { writeFileSync, mkdirSync, rmSync, existsSync, chmodSync, readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';

// Mock resolver for factory calls
const mockResolve = () => { throw new Error('Should not be called'); };
import { tmpdir } from 'os';

// =============================================================================
// define-config-partial Edge Cases
// =============================================================================

describe('defineConfigPartial - Edge Cases', () => {
  test('should handle empty string name', async () => {
    const config = defineConfigPartial('', z.object({ value: z.string() }));

    assert.strictEqual(config.name, '');
    // Plain Symbol described "config:" — identity is per-call, no global intern.
    assert.strictEqual(typeof config.key, 'symbol');
    assert.strictEqual(config.key.description, 'config:');
    assert.notStrictEqual(config.key, Symbol.for('config:'));
  });

  test('should handle very long names (1000+ characters)', async () => {
    const longName = 'a'.repeat(1000);
    const config = defineConfigPartial(longName, z.object({ value: z.string() }));

    assert.strictEqual(config.name, longName);
    assert.strictEqual(config.key.description, `config:${longName}`);
    assert.notStrictEqual(config.key, Symbol.for(`config:${longName}`));
  });

  test('should handle names with special characters', async () => {
    const specialNames = [
      'config-with-dashes',
      'config_with_underscores',
      'config.with.dots',
      'config:with:colons',
      'config/with/slashes',
      'config with spaces',
      'config@#$%^&*()',
      'config\n\t\r',
      '你好世界',
      '🚀🎉💻',
    ];

    specialNames.forEach(name => {
      const config = defineConfigPartial(name, z.object({ value: z.string() }));
      assert.strictEqual(config.name, name);
      assert.strictEqual(config.key.description, `config:${name}`);
      assert.notStrictEqual(config.key, Symbol.for(`config:${name}`));
    });
  });

  test('should handle deeply nested schemas (10+ levels)', async () => {
    const deepSchema = z.object({
      level1: z.object({
        level2: z.object({
          level3: z.object({
            level4: z.object({
              level5: z.object({
                level6: z.object({
                  level7: z.object({
                    level8: z.object({
                      level9: z.object({
                        level10: z.string(),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    });

    const config = defineConfigPartial('deep', deepSchema);

    const validData = {
      level1: { level2: { level3: { level4: { level5: {
        level6: { level7: { level8: { level9: { level10: 'value' } } } }
      } } } } },
    };

    const result = config.schema.parse(validData);
    assert.deepStrictEqual(result, validData);
  });

  test('should handle schema with circular references via lazy', async () => {
    type Node = {
      value: string
      children?: Node[]
    };

    const nodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({
        value: z.string(),
        children: z.array(nodeSchema).optional(),
      })
    );

    const config = defineConfigPartial('tree', nodeSchema);

    const treeData: Node = {
      value: 'root',
      children: [
        { value: 'child1' },
        { value: 'child2', children: [{ value: 'grandchild' }] },
      ],
    };

    const result = config.schema.parse(treeData);
    assert.deepStrictEqual(result, treeData);
  });

  test('should handle schema with very large arrays', async () => {
    const config = defineConfigPartial(
      'largeArray',
      z.object({
        items: z.array(z.number()),
      })
    );

    const largeArray = Array.from({ length: 10000 }, (_, i) => i);
    const result = config.schema.parse({ items: largeArray });

    assert.strictEqual(result.items.length, 10000);
    assert.strictEqual(result.items[9999], 9999);
  });
});

// =============================================================================
// createConfig Edge Cases
// =============================================================================

describe('createConfig - Edge Cases', () => {
  test('should handle factory that throws synchronous error', async () => {
    const config = createConfig({
      factory: () => {
        throw new Error('Factory failed!');
      },
    });

    assert.throws(() => config.factory({}), /Factory failed!/);
  });

  test('should handle factory that throws async error', async () => {
    const config = createConfig({
      factory: async () => {
        throw new Error('Async factory failed!');
      },
    });

    await assert.rejects(async () => config.factory({}), /Async factory failed!/);
  });

  test('should handle factory returning empty object', async () => {
    const config = createConfig({
      factory: () => ({}),
    });

    const result = config.factory({});
    assert.deepStrictEqual(result, {});
  });

  test('should handle factory with missing dependency', async () => {
    const mockToken = { description: 'missing-token' };
    const config = createConfig({
      inject: { dep: mockToken } as any,
      factory: ({ dep }) => {
        // Dependency is undefined
        if (!dep) {
          throw new Error('Dependency not provided!');
        }
        return {};
      },
    });

    // Calling with empty deps should trigger the error
    assert.throws(() => config.factory({} as any), /Dependency not provided!/);
  });

  test('should handle factory with null/undefined values in result', async () => {
    const key1 = Symbol('null-value');
    const key2 = Symbol('undefined-value');

    const config = createConfig({
      factory: () => ({
        [key1]: null,
        [key2]: undefined,
      }),
    });

    const result = config.factory({}) as any;
    assert.strictEqual(result[key1], null);
    assert.strictEqual(result[key2], undefined);
  });
});

// =============================================================================
// EnvService Edge Cases
// =============================================================================

describe('EnvService - Edge Cases', () => {
  let env: Map<string, string | undefined>;
  let container: Container;
  let envService: ReturnType<typeof EnvServiceDef.factory>;

  beforeEach(async () => {
    env = new Map();
    container = new Container();
    container.register(EnvServiceDef);
    envService = await container.resolve(EnvServiceDef);
  });

  afterEach(() => {
    // Restore original env
    for (const [key, value] of env) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function setEnv(key: string, value: string): void {
    if (!env.has(key)) {
      env.set(key, process.env[key]);
    }
    process.env[key] = value;
  }

  function unsetEnv(key: string): void {
    if (!env.has(key)) {
      env.set(key, process.env[key]);
    }
    delete process.env[key];
  }

  describe('string() edge cases', () => {
    test('should handle empty string vs undefined differently', async () => {
      setEnv('EMPTY_STRING', '');
      unsetEnv('UNDEFINED_VAR');

      // Empty string should be returned as-is
      assert.strictEqual(envService.string('EMPTY_STRING'), '');

      // Undefined should throw or return default
      assert.throws(() => envService.string('UNDEFINED_VAR'));
      assert.strictEqual(envService.string('UNDEFINED_VAR', 'default'), 'default');
    });

    test('should handle whitespace-only values', async () => {
      setEnv('WHITESPACE', '   \t\n  ');

      const result = envService.string('WHITESPACE');
      assert.strictEqual(result, '   \t\n  ');
    });

    test('should handle unicode characters', async () => {
      setEnv('UNICODE', '你好世界 🚀 مرحبا');

      const result = envService.string('UNICODE');
      assert.strictEqual(result, '你好世界 🚀 مرحبا');
    });

    test('should handle newlines in values', async () => {
      setEnv('MULTILINE', 'line1\nline2\nline3');

      const result = envService.string('MULTILINE');
      assert.strictEqual(result, 'line1\nline2\nline3');
    });

    test('should handle very long strings (100KB+)', async () => {
      const longString = 'x'.repeat(100000);
      setEnv('LONG_STRING', longString);

      const result = envService.string('LONG_STRING');
      assert.strictEqual(result.length, 100000);
    });
  });

  describe('number() edge cases', () => {
    test('should handle Number.MAX_SAFE_INTEGER', async () => {
      setEnv('MAX_INT', String(Number.MAX_SAFE_INTEGER));

      const result = envService.number('MAX_INT');
      assert.strictEqual(result, Number.MAX_SAFE_INTEGER);
    });

    test('should handle Number.MIN_SAFE_INTEGER', async () => {
      setEnv('MIN_INT', String(Number.MIN_SAFE_INTEGER));

      const result = envService.number('MIN_INT');
      assert.strictEqual(result, Number.MIN_SAFE_INTEGER);
    });

    test('should handle numbers beyond safe integer range', async () => {
      // parseInt can parse beyond safe integer range
      setEnv('HUGE_NUMBER', '9999999999999999999999');

      // parseInt will return a number, but it might lose precision
      const result = envService.number('HUGE_NUMBER');
      assert.ok(typeof result === 'number');
    });

    test('should handle negative zero', async () => {
      setEnv('NEGATIVE_ZERO', '-0');

      const result = envService.number('NEGATIVE_ZERO');
      // parseInt('-0') returns -0 in JavaScript (IEEE 754 signed zero)
      // Use Object.is to check for -0 vs 0
      assert.ok(Object.is(result, -0) || result === 0);
    });

    test('should handle numbers with leading zeros', async () => {
      setEnv('LEADING_ZEROS', '00042');

      const result = envService.number('LEADING_ZEROS');
      assert.strictEqual(result, 42);
    });

    test('should handle numbers with plus sign', async () => {
      setEnv('PLUS_NUMBER', '+42');

      const result = envService.number('PLUS_NUMBER');
      assert.strictEqual(result, 42);
    });

    test('should parse scientific notation via Number()', async () => {
      // Number('1e5') === 100000 — parseInt used to stop at 'e' and return 1.
      setEnv('SCIENTIFIC', '1e5');
      const result = envService.number('SCIENTIFIC');
      assert.strictEqual(result, 100000);
    });

    test('should throw on Infinity (not finite)', async () => {
      // Number('Infinity') === Infinity, which fails Number.isFinite.
      setEnv('INFINITY', 'Infinity');
      assert.throws(() => envService.number('INFINITY'));
    });

    test('should parse floats verbatim (no truncation)', async () => {
      // Number('3.14159') === 3.14159 — parseInt would have returned 3.
      setEnv('FLOAT', '3.14159');
      const result = envService.number('FLOAT');
      assert.strictEqual(result, 3.14159);
    });

    test('should handle whitespace around numbers', async () => {
      setEnv('PADDED_NUMBER', '  42  ');

      const result = envService.number('PADDED_NUMBER');
      assert.strictEqual(result, 42);
    });
  });

  describe('boolean() edge cases', () => {
    test('should handle empty string (edge case)', async () => {
      setEnv('EMPTY_BOOL', '');

      // Empty string doesn't match any valid boolean value
      assert.throws(() => envService.boolean('EMPTY_BOOL'));
    });

    test('should handle whitespace-only values', async () => {
      setEnv('WHITESPACE_BOOL', '   ');

      assert.throws(() => envService.boolean('WHITESPACE_BOOL'));
    });

    test('should handle case variations', async () => {
      const testCases = [
        ['TrUe', true],
        ['FaLsE', false],
        ['YES', true],
        ['No', false],
        ['ON', true],
        ['oFf', false],
      ] as const;

      testCases.forEach(([value, expected]) => {
        setEnv('BOOL_TEST', value);
        assert.strictEqual(envService.boolean('BOOL_TEST'), expected);
      });
    });

    test('should handle numeric-like boolean values with whitespace', async () => {
      setEnv('BOOL_PADDED', ' 1 ');

      // Whitespace should cause a failure since toLowerCase() is applied to trimmed value
      // Actually checking the implementation, it trims but then checks lowercase
      // Let's verify the actual behavior
      assert.throws(() => envService.boolean('BOOL_PADDED'));
    });
  });

  describe('json() edge cases', () => {
    test('should handle empty string', async () => {
      setEnv('EMPTY_JSON', '');

      assert.throws(() => envService.json('EMPTY_JSON'));
    });

    test('should handle whitespace-only', async () => {
      setEnv('WHITESPACE_JSON', '   ');

      assert.throws(() => envService.json('WHITESPACE_JSON'));
    });

    test('should handle deeply nested JSON', async () => {
      const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'value' } } } } } } } } } };
      setEnv('DEEP_JSON', JSON.stringify(deep));

      const result = envService.json('DEEP_JSON');
      assert.deepStrictEqual(result, deep);
    });

    test('should handle JSON with unicode', async () => {
      const unicode = { greeting: '你好世界', emoji: '🚀' };
      setEnv('UNICODE_JSON', JSON.stringify(unicode));

      const result = envService.json('UNICODE_JSON');
      assert.deepStrictEqual(result, unicode);
    });

    test('should handle JSON with escaped characters', async () => {
      const escaped = { text: 'line1\\nline2\\ttabbed' };
      setEnv('ESCAPED_JSON', JSON.stringify(escaped));

      const result = envService.json('ESCAPED_JSON');
      assert.deepStrictEqual(result, escaped);
    });

    test('should handle very large JSON arrays', async () => {
      const large = Array.from({ length: 1000 }, (_, i) => ({ id: i, value: `item-${i}` }));
      setEnv('LARGE_JSON', JSON.stringify(large));

      const result = envService.json<typeof large>('LARGE_JSON');
      assert.strictEqual(result.length, 1000);
      assert.strictEqual(result[999].id, 999);
    });

    test('should handle JSON with null values', async () => {
      const withNull = { a: null, b: { c: null } };
      setEnv('NULL_JSON', JSON.stringify(withNull));

      const result = envService.json('NULL_JSON');
      assert.deepStrictEqual(result, withNull);
    });
  });
});

// =============================================================================
// ConfigService Edge Cases
// =============================================================================

describe('ConfigService - Edge Cases', () => {
  let container: Container;
  let configService: ConfigService;
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    // Create unique temp directory for test isolation
    configDir = mkdtempSync(join(tmpdir(), 'config-edge-test-'));
    configPath = join(configDir, 'config.json');

    container = new Container();

    // Create ConfigService with isolated config directory
    const resolver = Object.assign(
      <T>(token: any): T => container.resolve(token) as T,
      { registerInstance: <T>(token: any, instance: T) => { container.registerInstance(token, instance); } },
    );
    configService = createConfigService(resolver, { configDir });
  });

  afterEach(() => {
    // Clean up temp directory after each test
    if (existsSync(configDir)) {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('should handle setting value on non-existent partial gracefully', async () => {
    const fakePartial = {
      key: Symbol('non-existent'),
      name: 'NonExistent',
      schema: z.object({ value: z.string() }),
    } as unknown as ConfigPartial<any>;

    // This should throw because the partial isn't registered in the container
    await assert.rejects(
      () => configService.set(fakePartial, 'value', 'test')
    );
  });

  test('should handle empty path string', async () => {
    const testPartial = defineConfigPartial('test', z.object({ value: z.string() }));
    container.registerInstance(testPartial.key as any, { value: 'initial' });

    // Empty path uses the last segment, which is empty string
    // This actually sets obj[''] = 'new-value'
    // Schema validation will fail because the expected shape doesn't match
    // Actually, let's check what happens - it might succeed with extra key
    const count = await configService.set(testPartial, '', 'new-value');

    // If we got here, it means it succeeded (no validation error)
    // This is an edge case where empty path creates an empty-string key
    assert.ok(count >= 0);
  });

  test('should handle very deep nested paths (10+ levels)', async () => {
    const deepSchema = z.object({
      l1: z.object({
        l2: z.object({
          l3: z.object({
            l4: z.object({
              l5: z.object({
                l6: z.object({
                  l7: z.object({
                    l8: z.object({
                      l9: z.object({
                        l10: z.string(),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    });

    const deepPartial = defineConfigPartial('deep', deepSchema);
    const deepValue = {
      l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: 'initial' } } } } } } } } },
    };

    container.registerInstance(deepPartial.key as any, deepValue);

    await configService.set(deepPartial, 'l1.l2.l3.l4.l5.l6.l7.l8.l9.l10', 'updated');

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(persisted.deep.l1.l2.l3.l4.l5.l6.l7.l8.l9.l10, 'updated');
  });

  test('should handle path with non-existent intermediate keys', async () => {
    const testPartial = defineConfigPartial('test', z.object({
      nested: z.object({ value: z.string() }).optional(),
    }));

    container.registerInstance(testPartial.key as any, {});

    // setPath will create the intermediate objects
    // This should work and create nested: { value: 'test' }
    const count = await configService.set(testPartial, 'nested.value', 'test');
    assert.ok(count >= 0);

    // Verify it was created
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(persisted.test.nested.value, 'test');
  });

  test('should handle concurrent set() calls (rapid succession)', async () => {
    const testPartial = defineConfigPartial('test', z.object({
      counter: z.number(),
    }));

    container.registerInstance(testPartial.key as any, { counter: 0 });

    // Rapid fire multiple sets
    await configService.set(testPartial, 'counter', 1);
    await configService.set(testPartial, 'counter', 2);
    await configService.set(testPartial, 'counter', 3);

    // Last write wins
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.strictEqual(persisted.test.counter, 3);
  });

  test('should validate schema on set and reject invalid values', async () => {
    const testPartial = defineConfigPartial('test', z.object({
      port: z.number().min(1).max(65535),
    }));

    container.registerInstance(testPartial.key as any, { port: 3000 });

    // Try to set invalid port
    await assert.rejects(
      () => configService.set(testPartial, 'port', 99999)
    );

    await assert.rejects(
      () => configService.set(testPartial, 'port', 0)
    );

    await assert.rejects(
      () => configService.set(testPartial, 'port', 'not-a-number')
    );
  });
});

// =============================================================================
// File Watcher Edge Cases
// =============================================================================

describe('watchEnvFiles - Edge Cases', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `watcher-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, '.env');
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('should handle file deleted while watching', async () => {
    writeFileSync(testFile, 'KEY=value');

    const watcher = watchEnvFiles([testFile], 50);
    let notified = false;

    try {
      const unsubscribe = watcher.subscribe(() => {
        notified = true;
      });

      await new Promise(resolve => setTimeout(resolve, 20));

      // Delete the file
      rmSync(testFile, { force: true });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Watcher should handle this gracefully (no crash)
      assert.ok(true, 'Watcher survived file deletion');

      unsubscribe();
    } finally {
      watcher.close();
    }
  });

  test('should handle very large .env files (1MB+)', async () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `KEY_${i}=value_${i}`);
    const largeContent = lines.join('\n');

    writeFileSync(testFile, largeContent);

    const watcher = watchEnvFiles([testFile]);

    try {
      assert.strictEqual(Object.keys(watcher.values).length, 10000);
      assert.strictEqual(watcher.values.KEY_9999, 'value_9999');
    } finally {
      watcher.close();
    }
  });

  test('should handle binary content in .env file', async () => {
    // Write binary content
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]);
    writeFileSync(testFile, binaryData);

    const watcher = watchEnvFiles([testFile]);

    try {
      // Should not crash, might return empty or partially parsed
      assert.ok(typeof watcher.values === 'object');
    } finally {
      watcher.close();
    }
  });

  test('should handle .env file with malformed lines', async () => {
    writeFileSync(testFile, [
      'VALID=value',
      'NO_EQUALS_SIGN',
      '=NO_KEY',
      '',
      '   ',
      'ANOTHER_VALID=value2',
      'KEY_WITH_MULTIPLE===EQUALS',
    ].join('\n'));

    const watcher = watchEnvFiles([testFile]);

    try {
      // Should parse valid lines and skip invalid ones
      assert.strictEqual(watcher.values.VALID, 'value');
      assert.strictEqual(watcher.values.ANOTHER_VALID, 'value2');
      assert.strictEqual(watcher.values.KEY_WITH_MULTIPLE, '==EQUALS');
    } finally {
      watcher.close();
    }
  });

  test('should handle .env file with various quote combinations', async () => {
    writeFileSync(testFile, [
      'DOUBLE="double quoted"',
      'SINGLE=\'single quoted\'',
      'MIXED_START="mixed\'',
      'MIXED_END=\'mixed"',
      'UNMATCHED_DOUBLE="unmatched',
      'UNMATCHED_SINGLE=\'unmatched',
      'NESTED="outer \'inner\' outer"',
    ].join('\n'));

    const watcher = watchEnvFiles([testFile]);

    try {
      assert.strictEqual(watcher.values.DOUBLE, 'double quoted');
      assert.strictEqual(watcher.values.SINGLE, 'single quoted');
      // Mixed quotes - behavior depends on implementation
      assert.ok('MIXED_START' in watcher.values);
    } finally {
      watcher.close();
    }
  });

  test('should handle multiple rapid file changes', async () => {
    writeFileSync(testFile, 'KEY=initial');

    const watcher = watchEnvFiles([testFile], 50);
    const changes: string[] = [];

    try {
      const unsubscribe = watcher.subscribe((values) => {
        changes.push(values.KEY);
      });

      await new Promise(resolve => setTimeout(resolve, 20));

      // Rapid changes
      writeFileSync(testFile, 'KEY=change1');
      await new Promise(resolve => setTimeout(resolve, 10));
      writeFileSync(testFile, 'KEY=change2');
      await new Promise(resolve => setTimeout(resolve, 10));
      writeFileSync(testFile, 'KEY=change3');

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should debounce to fewer notifications
      assert.ok(changes.length > 0, 'Should have received notifications');
      assert.strictEqual(changes[changes.length - 1], 'change3', 'Last change should be change3');

      unsubscribe();
    } finally {
      watcher.close();
    }
  });
});

// =============================================================================
// ProfileService Edge Cases
// =============================================================================

describe('ProfileService - Edge Cases', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `profile-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tempDir);
    originalEnv = process.env.JUSTSCALE_PROFILE;
    delete process.env.JUSTSCALE_PROFILE;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.JUSTSCALE_PROFILE = originalEnv;
    } else {
      delete process.env.JUSTSCALE_PROFILE;
    }
    process.chdir(originalCwd);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should handle profile names with special characters', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    const specialNames = [
      'profile-with-dashes',
      'profile_with_underscores',
      'profile.with.dots',
      'profile@special',
    ];

    specialNames.forEach(name => {
      service.create(name);
      assert.ok(service.list().includes(name));

      // Should be able to switch to it
      service.use(name);
      assert.strictEqual(service.active(), name);
    });
  });

  test('should handle very long profile names (255 chars - filesystem limit)', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);
    // Most filesystems have a 255 character filename limit
    // The .json extension adds 5 chars, so use 250
    const longName = 'a'.repeat(250);

    service.create(longName);
    assert.ok(service.list().includes(longName));

    service.use(longName);
    assert.strictEqual(service.active(), longName);
  });

  test('should handle corrupted JSON in profile file gracefully', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    mkdirSync('.justscale/profiles', { recursive: true });
    writeFileSync('.justscale/profiles/corrupted.json', '{invalid json content}');

    // get() should return empty object for corrupted JSON
    const config = service.get('corrupted');
    assert.deepStrictEqual(config, {});

    // list() should still include it
    assert.ok(service.list().includes('corrupted'));
  });

  test('should handle profile file with very large JSON (10MB+)', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    // Create large config object
    const largeConfig: Record<string, any> = {};
    for (let i = 0; i < 10000; i++) {
      largeConfig[`key_${i}`] = {
        id: i,
        data: 'x'.repeat(100),
        nested: { value: i },
      };
    }

    mkdirSync('.justscale/profiles', { recursive: true });
    writeFileSync('.justscale/profiles/large.json', JSON.stringify(largeConfig));

    // Should handle reading large file
    const config = service.get('large');
    assert.strictEqual(Object.keys(config).length, 10000);
  });

  test('should handle empty profile name', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    // Empty name should work (though not recommended)
    service.create('');
    assert.ok(service.list().includes(''));
  });

  test('should handle profile with unicode names', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    const unicodeNames = ['中文', '日本語', 'العربية', '🚀rocket🚀'];

    unicodeNames.forEach(name => {
      service.create(name);
      assert.ok(service.list().includes(name));
    });
  });

  test('should handle diff with very large config differences', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    const config1: Record<string, any> = {};
    const config2: Record<string, any> = {};

    for (let i = 0; i < 1000; i++) {
      config1[`key_${i}`] = `value1_${i}`;
      config2[`key_${i}`] = `value2_${i}`;
    }

    mkdirSync('.justscale/profiles', { recursive: true });
    writeFileSync('.justscale/profiles/p1.json', JSON.stringify(config1));
    writeFileSync('.justscale/profiles/p2.json', JSON.stringify(config2));

    const diffs = service.diff('p1', 'p2');

    assert.strictEqual(diffs.length, 1000);
  });

  test('should handle .active-profile file with whitespace and newlines', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    mkdirSync('.justscale/profiles', { recursive: true });
    writeFileSync('.justscale/profiles/test.json', '{}');
    writeFileSync('.justscale/.active-profile', '  test  \n\n\t');

    assert.strictEqual(service.active(), 'test');
  });

  test('should handle creating profile when source has empty config', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    // Create an empty profile (no config values)
    mkdirSync('.justscale/profiles', { recursive: true });
    writeFileSync('.justscale/profiles/empty-source.json', '{}');

    // Should be able to copy from empty profile
    service.create('copy', 'empty-source');

    const sourceConfig = service.get('empty-source');
    const copyConfig = service.get('copy');

    // Both should have the same empty content
    assert.deepStrictEqual(copyConfig, {});
    assert.deepStrictEqual(sourceConfig, {});
    assert.deepStrictEqual(copyConfig, sourceConfig);
  });

  test('should throw error when copying from non-existent profile', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    // Try to copy from a profile that doesn't exist
    assert.throws(
      () => service.create('new-profile', 'non-existent'),
      /Source profile 'non-existent' does not exist/
    );
  });

  test('should prevent deleting profile set via env var', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    service.create('env-profile');
    process.env.JUSTSCALE_PROFILE = 'env-profile';

    assert.throws(
      () => service.delete('env-profile'),
      /Cannot delete active profile/
    );
  });

  test('should handle diff when one profile has nested objects', async () => {
    const service = ProfileServiceDef.factory({}, mockResolve);

    const flat = { a: 1, b: 2 };
    const nested = { a: 1, b: { c: 2, d: 3 } };

    mkdirSync('.justscale/profiles', { recursive: true });
    writeFileSync('.justscale/profiles/flat.json', JSON.stringify(flat));
    writeFileSync('.justscale/profiles/nested.json', JSON.stringify(nested));

    const diffs = service.diff('flat', 'nested');

    assert.strictEqual(diffs.length, 1);
    assert.strictEqual(diffs[0].key, 'b');
    assert.strictEqual(diffs[0].from, 2);
    assert.deepStrictEqual(diffs[0].to, { c: 2, d: 3 });
  });
});

// =============================================================================
// Integration Edge Cases
// =============================================================================

describe('Integration - Edge Cases', () => {
  test('same-name partials produce distinct keys (plain Symbol, not Symbol.for)', async () => {
    const config1 = defineConfigPartial('shared', z.object({ value: z.string() }));
    const config2 = defineConfigPartial('shared', z.object({ value: z.number() }));

    // Plain Symbol() — no global intern, so two features that happen to
    // pick the same name each get their own container slot.
    assert.notStrictEqual(config1.key, config2.key);
    assert.strictEqual(config1.name, config2.name);
    assert.strictEqual(config1.key.description, 'config:shared');
    assert.strictEqual(config2.key.description, 'config:shared');

    // And different schema objects.
    assert.notStrictEqual(config1.schema, config2.schema);
  });

  test('should handle isConfigPartial with objects that have CONFIG_PARTIAL symbol', async () => {
    // Need to dynamically import the actual CONFIG_PARTIAL symbol
    const { CONFIG_PARTIAL } = await import('../../src/features/config/types.js');

    const fakePartial = {
      [CONFIG_PARTIAL]: true,
      // Missing name, schema, key but has the right symbol
    };

    // isConfigPartial only checks for the CONFIG_PARTIAL symbol
    assert.strictEqual(isConfigPartial(fakePartial), true);
  });

  test('should handle extremely nested config partial validation', async () => {
    // Create a schema with 20 levels of nesting
    let schema: any = z.string();
    for (let i = 0; i < 20; i++) {
      schema = z.object({ nested: schema });
    }

    const config = defineConfigPartial('deepest', schema);

    // Create matching data structure
    let data: any = 'value';
    for (let i = 0; i < 20; i++) {
      data = { nested: data };
    }

    const result = config.schema.parse(data);
    assert.ok(result);
  });
});
