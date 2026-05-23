/**
 * EnvService Tests
 *
 * Tests for the EnvService implementation that provides typed access to environment variables.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EnvServiceDef } from '../../src/features/config/env-service.js';
import { Container } from '@justscale/core';

/**
 * Helper to temporarily set environment variables for testing.
 * Saves the original value and restores it after the test.
 */
class EnvHelper {
  private original = new Map<string, string | undefined>();

  set(key: string, value: string): void {
    if (!this.original.has(key)) {
      this.original.set(key, process.env[key]);
    }
    process.env[key] = value;
  }

  unset(key: string): void {
    if (!this.original.has(key)) {
      this.original.set(key, process.env[key]);
    }
    delete process.env[key];
  }

  restore(): void {
    for (const [key, value] of this.original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    this.original.clear();
  }
}

describe('EnvService', () => {
  let env: EnvHelper;
  let container: Container;
  let envService: ReturnType<typeof EnvServiceDef.factory>;

  beforeEach(async () => {
    env = new EnvHelper();
    container = new Container();
    container.register(EnvServiceDef);
    envService = await container.resolve(EnvServiceDef);
  });

  afterEach(() => {
    env.restore();
  });

  describe('string()', () => {
    test('should return env value when set', () => {
      env.set('TEST_STRING', 'hello world');
      const result = envService.string('TEST_STRING');
      assert.strictEqual(result, 'hello world');
    });

    test('should return default when not set', () => {
      env.unset('TEST_MISSING');
      const result = envService.string('TEST_MISSING', 'default-value');
      assert.strictEqual(result, 'default-value');
    });

    test('should throw when required and not set', () => {
      env.unset('TEST_REQUIRED');
      assert.throws(
        () => envService.string('TEST_REQUIRED'),
        {
          message: 'Required environment variable "TEST_REQUIRED" is not set',
        }
      );
    });

    test('should return empty string when env value is empty', () => {
      env.set('TEST_EMPTY', '');
      const result = envService.string('TEST_EMPTY');
      assert.strictEqual(result, '');
    });

    test('should handle special characters', () => {
      env.set('TEST_SPECIAL', 'hello@#$%^&*()');
      const result = envService.string('TEST_SPECIAL');
      assert.strictEqual(result, 'hello@#$%^&*()');
    });
  });

  describe('number()', () => {
    test('should parse valid integers', () => {
      env.set('TEST_NUMBER', '42');
      const result = envService.number('TEST_NUMBER');
      assert.strictEqual(result, 42);
    });

    test('should parse negative integers', () => {
      env.set('TEST_NEGATIVE', '-123');
      const result = envService.number('TEST_NEGATIVE');
      assert.strictEqual(result, -123);
    });

    test('should parse zero', () => {
      env.set('TEST_ZERO', '0');
      const result = envService.number('TEST_ZERO');
      assert.strictEqual(result, 0);
    });

    test('should return default when not set', () => {
      env.unset('TEST_NUMBER_MISSING');
      const result = envService.number('TEST_NUMBER_MISSING', 999);
      assert.strictEqual(result, 999);
    });

    test('should throw when required and not set', () => {
      env.unset('TEST_NUMBER_REQUIRED');
      assert.throws(
        () => envService.number('TEST_NUMBER_REQUIRED'),
        {
          message: 'Required environment variable "TEST_NUMBER_REQUIRED" is not set',
        }
      );
    });

    test('should throw on non-numeric values', () => {
      env.set('TEST_INVALID_NUMBER', 'not-a-number');
      assert.throws(
        () => envService.number('TEST_INVALID_NUMBER'),
        /value 'not-a-number' is not a valid number/,
      );
    });

    test('should throw on partial numeric values ("123abc")', () => {
      // Number('123abc') === NaN — we reject partial parses instead of
      // silently returning 123 like parseInt used to.
      env.set('TEST_PARTIAL_NUMBER', '123abc');
      assert.throws(
        () => envService.number('TEST_PARTIAL_NUMBER'),
        /value '123abc' is not a valid number/,
      );
    });

    test('parses floats verbatim (no silent truncation)', () => {
      // Number('3.14') === 3.14 — parseInt would have truncated to 3.
      env.set('TEST_FLOAT', '3.14');
      const result = envService.number('TEST_FLOAT');
      assert.strictEqual(result, 3.14);
    });

    test('should throw on empty string (not a valid number)', () => {
      // Number('') === 0 would silently turn a blank env var into zero.
      // We reject empty strings explicitly, matching the `has()` rule
      // that empty strings are not a usable value.
      env.set('TEST_EMPTY_NUMBER', '');
      assert.throws(
        () => envService.number('TEST_EMPTY_NUMBER'),
        /value '' is not a valid number/,
      );
    });
  });

  describe('boolean()', () => {
    test('should handle truthy: "true"', () => {
      env.set('TEST_BOOL_TRUE', 'true');
      const result = envService.boolean('TEST_BOOL_TRUE');
      assert.strictEqual(result, true);
    });

    test('should handle truthy: "1"', () => {
      env.set('TEST_BOOL_1', '1');
      const result = envService.boolean('TEST_BOOL_1');
      assert.strictEqual(result, true);
    });

    test('should handle truthy: "yes"', () => {
      env.set('TEST_BOOL_YES', 'yes');
      const result = envService.boolean('TEST_BOOL_YES');
      assert.strictEqual(result, true);
    });

    test('should handle truthy: "on"', () => {
      env.set('TEST_BOOL_ON', 'on');
      const result = envService.boolean('TEST_BOOL_ON');
      assert.strictEqual(result, true);
    });

    test('should handle falsy: "false"', () => {
      env.set('TEST_BOOL_FALSE', 'false');
      const result = envService.boolean('TEST_BOOL_FALSE');
      assert.strictEqual(result, false);
    });

    test('should handle falsy: "0"', () => {
      env.set('TEST_BOOL_0', '0');
      const result = envService.boolean('TEST_BOOL_0');
      assert.strictEqual(result, false);
    });

    test('should handle falsy: "no"', () => {
      env.set('TEST_BOOL_NO', 'no');
      const result = envService.boolean('TEST_BOOL_NO');
      assert.strictEqual(result, false);
    });

    test('should handle falsy: "off"', () => {
      env.set('TEST_BOOL_OFF', 'off');
      const result = envService.boolean('TEST_BOOL_OFF');
      assert.strictEqual(result, false);
    });

    test('should be case insensitive for truthy values', () => {
      env.set('TEST_BOOL_UPPER', 'TRUE');
      const result = envService.boolean('TEST_BOOL_UPPER');
      assert.strictEqual(result, true);
    });

    test('should be case insensitive for falsy values', () => {
      env.set('TEST_BOOL_LOWER', 'FALSE');
      const result = envService.boolean('TEST_BOOL_LOWER');
      assert.strictEqual(result, false);
    });

    test('should throw on invalid boolean strings', () => {
      env.set('TEST_BOOL_INVALID', 'maybe');
      assert.throws(
        () => envService.boolean('TEST_BOOL_INVALID'),
        {
          message: 'Environment variable "TEST_BOOL_INVALID" has invalid boolean value: "maybe". Expected one of: true, false, 1, 0, yes, no, on, off',
        }
      );
    });

    test('should return default when not set', () => {
      env.unset('TEST_BOOL_MISSING');
      const result = envService.boolean('TEST_BOOL_MISSING', true);
      assert.strictEqual(result, true);
    });

    test('should return false when not set and no default provided', () => {
      env.unset('TEST_BOOL_NO_DEFAULT');
      const result = envService.boolean('TEST_BOOL_NO_DEFAULT');
      assert.strictEqual(result, false);
    });

    test('should handle mixed case: "Yes"', () => {
      env.set('TEST_BOOL_MIXED', 'Yes');
      const result = envService.boolean('TEST_BOOL_MIXED');
      assert.strictEqual(result, true);
    });

    test('should throw on whitespace-only values', () => {
      env.set('TEST_BOOL_WHITESPACE', '   ');
      assert.throws(
        () => envService.boolean('TEST_BOOL_WHITESPACE'),
        {
          message: 'Environment variable "TEST_BOOL_WHITESPACE" has invalid boolean value: "   ". Expected one of: true, false, 1, 0, yes, no, on, off',
        }
      );
    });
  });

  describe('json()', () => {
    test('should parse valid JSON object', () => {
      env.set('TEST_JSON_OBJECT', '{"name":"test","value":42}');
      const result = envService.json('TEST_JSON_OBJECT');
      assert.deepStrictEqual(result, { name: 'test', value: 42 });
    });

    test('should parse valid JSON array', () => {
      env.set('TEST_JSON_ARRAY', '[1,2,3]');
      const result = envService.json('TEST_JSON_ARRAY');
      assert.deepStrictEqual(result, [1, 2, 3]);
    });

    test('should parse JSON string', () => {
      env.set('TEST_JSON_STRING', '"hello"');
      const result = envService.json('TEST_JSON_STRING');
      assert.strictEqual(result, 'hello');
    });

    test('should parse JSON number', () => {
      env.set('TEST_JSON_NUMBER', '123');
      const result = envService.json('TEST_JSON_NUMBER');
      assert.strictEqual(result, 123);
    });

    test('should parse JSON boolean', () => {
      env.set('TEST_JSON_BOOL', 'true');
      const result = envService.json('TEST_JSON_BOOL');
      assert.strictEqual(result, true);
    });

    test('should parse JSON null', () => {
      env.set('TEST_JSON_NULL', 'null');
      const result = envService.json('TEST_JSON_NULL');
      assert.strictEqual(result, null);
    });

    test('should parse nested JSON', () => {
      env.set('TEST_JSON_NESTED', '{"outer":{"inner":"value"}}');
      const result = envService.json('TEST_JSON_NESTED');
      assert.deepStrictEqual(result, { outer: { inner: 'value' } });
    });

    test('should throw on invalid JSON', () => {
      env.set('TEST_JSON_INVALID', '{invalid json}');
      assert.throws(
        () => envService.json('TEST_JSON_INVALID'),
        (error: Error) => {
          return error.message.includes('Environment variable "TEST_JSON_INVALID" has invalid JSON value');
        }
      );
    });

    test('should throw on malformed JSON', () => {
      env.set('TEST_JSON_MALFORMED', '{"key": }');
      assert.throws(
        () => envService.json('TEST_JSON_MALFORMED'),
        (error: Error) => {
          return error.message.includes('Environment variable "TEST_JSON_MALFORMED" has invalid JSON value');
        }
      );
    });

    test('should return default when not set', () => {
      env.unset('TEST_JSON_MISSING');
      const result = envService.json('TEST_JSON_MISSING', { default: true });
      assert.deepStrictEqual(result, { default: true });
    });

    test('should throw when required and not set', () => {
      env.unset('TEST_JSON_REQUIRED');
      assert.throws(
        () => envService.json('TEST_JSON_REQUIRED'),
        {
          message: 'Required environment variable "TEST_JSON_REQUIRED" is not set',
        }
      );
    });

    test('should handle complex objects with arrays', () => {
      env.set('TEST_JSON_COMPLEX', '{"users":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}],"count":2}');
      const result = envService.json('TEST_JSON_COMPLEX');
      assert.deepStrictEqual(result, {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        count: 2,
      });
    });
  });

  describe('has()', () => {
    test('should return true when key exists', () => {
      env.set('TEST_EXISTS', 'value');
      const result = envService.has('TEST_EXISTS');
      assert.strictEqual(result, true);
    });

    test('should return false when key does not exist', () => {
      env.unset('TEST_NOT_EXISTS');
      const result = envService.has('TEST_NOT_EXISTS');
      assert.strictEqual(result, false);
    });

    test('should return false for empty string values', () => {
      // has() answers "is there a usable value here". An empty env var is
      // treated as absent so callers can rely on `has(k)` implying something
      // meaningful to read.
      env.set('TEST_EMPTY_STRING', '');
      const result = envService.has('TEST_EMPTY_STRING');
      assert.strictEqual(result, false);
    });

    test('should return true for zero values', () => {
      env.set('TEST_ZERO_VALUE', '0');
      const result = envService.has('TEST_ZERO_VALUE');
      assert.strictEqual(result, true);
    });

    test('should return true for false string', () => {
      env.set('TEST_FALSE_STRING', 'false');
      const result = envService.has('TEST_FALSE_STRING');
      assert.strictEqual(result, true);
    });
  });

  describe('raw()', () => {
    test('should return raw value when key exists', () => {
      env.set('TEST_RAW', 'raw-value');
      const result = envService.raw('TEST_RAW');
      assert.strictEqual(result, 'raw-value');
    });

    test('should return undefined for missing keys', () => {
      env.unset('TEST_RAW_MISSING');
      const result = envService.raw('TEST_RAW_MISSING');
      assert.strictEqual(result, undefined);
    });

    test('should return empty string when value is empty', () => {
      env.set('TEST_RAW_EMPTY', '');
      const result = envService.raw('TEST_RAW_EMPTY');
      assert.strictEqual(result, '');
    });

    test('should not parse or transform the value', () => {
      env.set('TEST_RAW_NUMBER', '123');
      const result = envService.raw('TEST_RAW_NUMBER');
      assert.strictEqual(typeof result, 'string');
      assert.strictEqual(result, '123');
    });

    test('should not parse JSON values', () => {
      env.set('TEST_RAW_JSON', '{"key":"value"}');
      const result = envService.raw('TEST_RAW_JSON');
      assert.strictEqual(typeof result, 'string');
      assert.strictEqual(result, '{"key":"value"}');
    });

    test('should return boolean strings as-is', () => {
      env.set('TEST_RAW_BOOL', 'true');
      const result = envService.raw('TEST_RAW_BOOL');
      assert.strictEqual(typeof result, 'string');
      assert.strictEqual(result, 'true');
    });
  });

  describe('Integration tests', () => {
    test('should handle multiple env variables independently', () => {
      env.set('APP_NAME', 'MyApp');
      env.set('APP_PORT', '3000');
      env.set('APP_DEBUG', 'true');
      env.set('APP_CONFIG', '{"timeout":5000}');

      assert.strictEqual(envService.string('APP_NAME'), 'MyApp');
      assert.strictEqual(envService.number('APP_PORT'), 3000);
      assert.strictEqual(envService.boolean('APP_DEBUG'), true);
      assert.deepStrictEqual(envService.json('APP_CONFIG'), { timeout: 5000 });
    });

    test('should work with real-world config scenario', () => {
      env.set('DATABASE_URL', 'postgresql://localhost:5432/mydb');
      env.set('DATABASE_POOL_SIZE', '10');
      env.set('DATABASE_SSL', 'false');
      env.set('FEATURE_FLAGS', '["new-ui","beta-api"]');

      const config = {
        databaseUrl: envService.string('DATABASE_URL'),
        poolSize: envService.number('DATABASE_POOL_SIZE'),
        ssl: envService.boolean('DATABASE_SSL'),
        features: envService.json<string[]>('FEATURE_FLAGS'),
      };

      assert.deepStrictEqual(config, {
        databaseUrl: 'postgresql://localhost:5432/mydb',
        poolSize: 10,
        ssl: false,
        features: ['new-ui', 'beta-api'],
      });
    });

    test('should allow checking existence before reading', () => {
      env.set('OPTIONAL_SETTING', 'value');
      env.unset('MISSING_SETTING');

      if (envService.has('OPTIONAL_SETTING')) {
        const value = envService.string('OPTIONAL_SETTING');
        assert.strictEqual(value, 'value');
      }

      if (envService.has('MISSING_SETTING')) {
        // Should not execute
        assert.fail('Should not reach here');
      } else {
        // Should execute
        assert.ok(true);
      }
    });
  });

  describe('Edge cases', () => {
    test('should handle unicode characters', () => {
      env.set('TEST_UNICODE', '你好世界');
      const result = envService.string('TEST_UNICODE');
      assert.strictEqual(result, '你好世界');
    });

    test('should handle newlines in JSON', () => {
      env.set('TEST_JSON_NEWLINE', '{"text":"line1\\nline2"}');
      const result = envService.json('TEST_JSON_NEWLINE');
      assert.deepStrictEqual(result, { text: 'line1\nline2' });
    });

    test('should handle very large numbers', () => {
      env.set('TEST_LARGE_NUMBER', '999999999');
      const result = envService.number('TEST_LARGE_NUMBER');
      assert.strictEqual(result, 999999999);
    });

    test('parses hexadecimal notation via Number()', () => {
      // Number('0x10') === 16; parseInt(_, 10) would have stopped at 'x'
      // and returned 0, which is a silent footgun. Number's full-string
      // parse is now the documented behaviour.
      env.set('TEST_HEX', '0x10');
      const result = envService.number('TEST_HEX');
      assert.strictEqual(result, 16);
    });
  });
});
