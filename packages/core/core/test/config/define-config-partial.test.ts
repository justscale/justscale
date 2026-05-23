/**
 * Tests for defineConfigPartial and related utilities
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';

import {
  defineConfigPartial,
  CONFIG_PARTIAL,
  isConfigPartial,
} from '../../src/features/config/index.js';

// =============================================================================
// defineConfigPartial Tests
// =============================================================================

describe('defineConfigPartial', () => {
  test('should create a config partial with correct name', () => {
    const dbConfig = defineConfigPartial(
      'database',
      z.object({
        host: z.string(),
        port: z.number(),
      })
    );

    assert.strictEqual(dbConfig.name, 'database');
  });

  test('should have CONFIG_PARTIAL symbol marker', () => {
    const appConfig = defineConfigPartial(
      'app',
      z.object({
        name: z.string(),
      })
    );

    assert.ok(CONFIG_PARTIAL in appConfig);
    assert.strictEqual(appConfig[CONFIG_PARTIAL], true);
  });

  test('should store the schema correctly', () => {
    const schema = z.object({
      timeout: z.number(),
      retries: z.number(),
    });

    const apiConfig = defineConfigPartial('api', schema);

    assert.strictEqual(apiConfig.schema, schema);
  });

  test('creates a fresh plain Symbol per call (no Symbol.for collisions)', () => {
    const config1 = defineConfigPartial(
      'auth',
      z.object({ enabled: z.boolean() })
    );
    const config2 = defineConfigPartial(
      'auth',
      z.object({ enabled: z.boolean() })
    );

    // Plain Symbol() — each call is a distinct token. Descriptions match
    // but identity does not, so two features cannot silently share a slot.
    assert.notStrictEqual(config1.key, config2.key);
    assert.strictEqual(config1.key.description, 'config:auth');
    assert.strictEqual(config2.key.description, 'config:auth');
    assert.notStrictEqual(config1.key, Symbol.for('config:auth'));
  });

  test('should create different keys for different names', () => {
    const config1 = defineConfigPartial(
      'redis',
      z.object({ url: z.string() })
    );
    const config2 = defineConfigPartial(
      'postgres',
      z.object({ url: z.string() })
    );

    // Different names should have different keys
    assert.notStrictEqual(config1.key, config2.key);
  });
});

// =============================================================================
// isConfigPartial Tests
// =============================================================================

describe('isConfigPartial', () => {
  test('should return true for valid config partials', () => {
    const config = defineConfigPartial(
      'test',
      z.object({ value: z.string() })
    );

    assert.strictEqual(isConfigPartial(config), true);
  });

  test('should return false for null', () => {
    assert.strictEqual(isConfigPartial(null), false);
  });

  test('should return false for undefined', () => {
    assert.strictEqual(isConfigPartial(undefined), false);
  });

  test('should return false for plain objects', () => {
    const plainObject = {
      name: 'test',
      schema: z.string(),
    };

    assert.strictEqual(isConfigPartial(plainObject), false);
  });

  test('should return false for objects with wrong symbol', () => {
    const fakeConfig = {
      [Symbol('other')]: true,
      name: 'fake',
      schema: z.string(),
    };

    assert.strictEqual(isConfigPartial(fakeConfig), false);
  });

  test('should return false for primitive values', () => {
    assert.strictEqual(isConfigPartial('string'), false);
    assert.strictEqual(isConfigPartial(123), false);
    assert.strictEqual(isConfigPartial(true), false);
  });

  test('should return false for arrays', () => {
    assert.strictEqual(isConfigPartial([]), false);
    assert.strictEqual(isConfigPartial([1, 2, 3]), false);
  });
});

// =============================================================================
// Schema Validation Tests
// =============================================================================

describe('Schema validation', () => {
  test('should validate correct data', () => {
    const serverConfig = defineConfigPartial(
      'server',
      z.object({
        host: z.string(),
        port: z.number(),
        ssl: z.boolean(),
      })
    );

    const validData = {
      host: 'localhost',
      port: 3000,
      ssl: false,
    };

    const result = serverConfig.schema.parse(validData);
    assert.deepStrictEqual(result, validData);
  });

  test('should throw on invalid data', () => {
    const userConfig = defineConfigPartial(
      'user',
      z.object({
        id: z.string(),
        age: z.number(),
      })
    );

    const invalidData = {
      id: 'user-123',
      age: 'not a number', // Invalid type
    };

    assert.throws(
      () => userConfig.schema.parse(invalidData),
      z.ZodError
    );
  });

  test('should throw on missing required fields', () => {
    const emailConfig = defineConfigPartial(
      'email',
      z.object({
        from: z.string(),
        smtp: z.string(),
      })
    );

    const incompleteData = {
      from: 'noreply@example.com',
      // smtp is missing
    };

    assert.throws(
      () => emailConfig.schema.parse(incompleteData),
      z.ZodError
    );
  });

  test('should allow extra fields with passthrough', () => {
    const baseConfig = defineConfigPartial(
      'base',
      z.object({
        name: z.string(),
      }).passthrough()
    );

    const dataWithExtra = {
      name: 'test',
      extra: 'allowed',
    };

    const result = baseConfig.schema.parse(dataWithExtra);
    assert.deepStrictEqual(result, dataWithExtra);
  });
});

// =============================================================================
// Schema Defaults Tests
// =============================================================================

describe('Schema defaults', () => {
  test('should apply default values', () => {
    const cacheConfig = defineConfigPartial(
      'cache',
      z.object({
        enabled: z.boolean().default(true),
        ttl: z.number().default(3600),
        maxSize: z.number(),
      })
    );

    const partialData = {
      maxSize: 1000,
    };

    const result = cacheConfig.schema.parse(partialData);
    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.ttl, 3600);
    assert.strictEqual(result.maxSize, 1000);
  });

  test('should allow overriding defaults', () => {
    const logConfig = defineConfigPartial(
      'logging',
      z.object({
        level: z.string().default('info'),
        format: z.string().default('json'),
      })
    );

    const customData = {
      level: 'debug',
      format: 'text',
    };

    const result = logConfig.schema.parse(customData);
    assert.strictEqual(result.level, 'debug');
    assert.strictEqual(result.format, 'text');
  });

  test('should handle optional fields', () => {
    const featuresConfig = defineConfigPartial(
      'features',
      z.object({
        analytics: z.boolean(),
        darkMode: z.boolean().optional(),
        beta: z.boolean().optional(),
      })
    );

    const minimalData = {
      analytics: true,
    };

    const result = featuresConfig.schema.parse(minimalData);
    assert.strictEqual(result.analytics, true);
    assert.strictEqual(result.darkMode, undefined);
    assert.strictEqual(result.beta, undefined);
  });

  test('should handle complex default values', () => {
    const serviceConfig = defineConfigPartial(
      'service',
      z.object({
        name: z.string(),
        endpoints: z.array(z.string()).default([]),
        metadata: z.record(z.string(), z.string()).default({}),
      })
    );

    const simpleData = {
      name: 'api',
    };

    const result = serviceConfig.schema.parse(simpleData);
    assert.strictEqual(result.name, 'api');
    assert.deepStrictEqual(result.endpoints, []);
    assert.deepStrictEqual(result.metadata, {});
  });
});

// =============================================================================
// Complex Schema Tests
// =============================================================================

describe('Complex schemas', () => {
  test('should handle nested objects', () => {
    const databaseConfig = defineConfigPartial(
      'database',
      z.object({
        host: z.string(),
        port: z.number(),
        credentials: z.object({
          username: z.string(),
          password: z.string(),
        }),
      })
    );

    const validData = {
      host: 'localhost',
      port: 5432,
      credentials: {
        username: 'admin',
        password: 'secret',
      },
    };

    const result = databaseConfig.schema.parse(validData);
    assert.deepStrictEqual(result, validData);
  });

  test('should handle arrays', () => {
    const clustersConfig = defineConfigPartial(
      'clusters',
      z.object({
        nodes: z.array(z.string()),
        replicas: z.number(),
      })
    );

    const validData = {
      nodes: ['node1', 'node2', 'node3'],
      replicas: 2,
    };

    const result = clustersConfig.schema.parse(validData);
    assert.deepStrictEqual(result, validData);
  });

  test('should handle enums', () => {
    const envConfig = defineConfigPartial(
      'environment',
      z.object({
        stage: z.enum(['development', 'staging', 'production']),
        region: z.string(),
      })
    );

    const validData = {
      stage: 'production' as const,
      region: 'us-east-1',
    };

    const result = envConfig.schema.parse(validData);
    assert.deepStrictEqual(result, validData);

    // Should throw on invalid enum value
    assert.throws(() => {
      envConfig.schema.parse({
        stage: 'invalid',
        region: 'us-east-1',
      });
    }, z.ZodError);
  });

  test('should handle unions', () => {
    const storageConfig = defineConfigPartial(
      'storage',
      z.object({
        type: z.union([z.literal('s3'), z.literal('gcs'), z.literal('local')]),
        bucket: z.string().optional(),
        path: z.string().optional(),
      })
    );

    const s3Data = {
      type: 's3' as const,
      bucket: 'my-bucket',
    };

    const result = storageConfig.schema.parse(s3Data);
    assert.strictEqual(result.type, 's3');
    assert.strictEqual(result.bucket, 'my-bucket');
  });
});

// =============================================================================
// Type Inference Tests
// =============================================================================

describe('Type inference', () => {
  test('should infer correct TypeScript types', () => {
    const typedConfig = defineConfigPartial(
      'typed',
      z.object({
        name: z.string(),
        count: z.number(),
        enabled: z.boolean(),
      })
    );

    // This test verifies compile-time type inference
    // If it compiles, the types are correct
    const data = typedConfig.schema.parse({
      name: 'test',
      count: 42,
      enabled: true,
    });

    // Type assertions (compile-time checks)
    const _name: string = data.name;
    const _count: number = data.count;
    const _enabled: boolean = data.enabled;

    assert.ok(true); // If it compiles, it works
  });
});
