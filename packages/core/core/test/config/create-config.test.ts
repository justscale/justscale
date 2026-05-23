import { describe, test } from 'node:test';
import assert from 'node:assert';
import { createConfig } from '../../src/features/config/create-config.js';
import { isConfigComponent } from '../../src/features/config/types.js';
import type { Token } from '@justscale/core';

describe('createConfig', () => {
  test('should return object with __configComponent: true', () => {
    const config = createConfig({
      factory: () => ({}),
    });

    assert.strictEqual(config.__configComponent, true);
  });

  test('should return a ConfigComponent', () => {
    const config = createConfig({
      factory: () => ({}),
    });

    assert.ok(isConfigComponent(config));
  });

  test('should default inject to empty object when not provided', () => {
    const config = createConfig({
      factory: () => ({}),
    });

    assert.deepStrictEqual(config.inject, {});
  });

  test('should store provided inject dependencies', () => {
    const mockToken: Token<string> = { description: 'mock' };
    const config = createConfig({
      inject: { dep: mockToken } as any,
      factory: () => ({}),
    });

    assert.strictEqual(config.inject.dep, mockToken);
  });

  test('should store factory function', () => {
    const factory = () => ({});
    const config = createConfig({
      factory,
    });

    assert.strictEqual(config.factory, factory);
  });

  test('should initialize provides as empty array', () => {
    const config = createConfig({
      factory: () => ({}),
    });

    assert.ok(Array.isArray(config.provides));
    assert.strictEqual(config.provides.length, 0);
  });

  test('factory should receive injected dependencies', () => {
    const mockToken: Token<string> = { description: 'mock' };
    let receivedDeps: any;

    const config = createConfig({
      inject: { dep: mockToken } as any,
      factory: (deps) => {
        receivedDeps = deps;
        return {};
      },
    });

    // Call factory to test dependency injection
    const mockDepValue = 'test-value';
    config.factory({ dep: mockDepValue });

    assert.deepStrictEqual(receivedDeps, { dep: mockDepValue });
  });

  test('factory should return symbol-keyed values', () => {
    const key1 = Symbol('config1');
    const key2 = Symbol('config2');

    const config = createConfig({
      factory: () => ({
        [key1]: { value: 'test1' },
        [key2]: { value: 'test2' },
      }),
    });

    const result = config.factory({}) as any;

    assert.strictEqual(result[key1].value, 'test1');
    assert.strictEqual(result[key2].value, 'test2');
  });

  test('factory can return empty object', () => {
    const config = createConfig({
      factory: () => ({}),
    });

    const result = config.factory({});

    assert.deepStrictEqual(result, {});
  });

  test('async factory should work correctly', async () => {
    const key = Symbol('asyncConfig');

    const config = createConfig({
      factory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          [key]: { value: 'async-test' },
        };
      },
    });

    const result = await config.factory({});

    assert.strictEqual(result[key].value, 'async-test');
  });

  test('async factory with dependencies', async () => {
    const mockToken: Token<{ getData: () => Promise<string> }> = {
      description: 'async-service',
    };
    const key = Symbol('config');

    const config = createConfig({
      inject: { service: mockToken } as any,
      factory: async (deps: any) => {
        const service = deps.service as { getData: () => Promise<string> };
        const data = await service.getData();
        return {
          [key]: { data },
        };
      },
    });

    const mockService = {
      getData: async () => 'async-data',
    };

    const result = await config.factory({ service: mockService });

    assert.strictEqual(result[key].data, 'async-data');
  });

  test('multiple dependencies with inferred types', () => {
    const tokenA: Token<string> = { description: 'token-a' };
    const tokenB: Token<number> = { description: 'token-b' };
    const tokenC: Token<boolean> = { description: 'token-c' };
    let capturedDeps: any;

    const config = createConfig({
      inject: { a: tokenA, b: tokenB, c: tokenC } as any,
      factory: (deps) => {
        capturedDeps = deps;
        return {};
      },
    });

    config.factory({ a: 'hello', b: 42, c: true });

    assert.strictEqual(capturedDeps.a, 'hello');
    assert.strictEqual(capturedDeps.b, 42);
    assert.strictEqual(capturedDeps.c, true);
  });

  test('factory can use dependencies to construct config', () => {
    const databaseToken: Token<{ host: string; port: number }> = {
      description: 'database',
    };
    const key = Symbol('db-config');

    const config = createConfig({
      inject: { db: databaseToken } as any,
      factory: (deps: any) => {
        const db = deps.db as { host: string; port: number };
        return {
          [key]: {
            connectionString: `${db.host}:${db.port}`,
          },
        };
      },
    });

    const result = config.factory({ db: { host: 'localhost', port: 5432 } }) as any;

    assert.strictEqual(result[key].connectionString, 'localhost:5432');
  });
});

describe('isConfigComponent type guard', () => {
  test('should return true for valid ConfigComponent', () => {
    const config = createConfig({
      factory: () => ({}),
    });

    assert.strictEqual(isConfigComponent(config), true);
  });

  test('should return false for plain object', () => {
    const notConfig = { foo: 'bar' };

    assert.strictEqual(isConfigComponent(notConfig), false);
  });

  test('should return false for null', () => {
    assert.strictEqual(isConfigComponent(null), false);
  });

  test('should return false for undefined', () => {
    assert.strictEqual(isConfigComponent(undefined), false);
  });

  test('should return false for object without __configComponent', () => {
    const notConfig = {
      provides: [],
      inject: {},
      factory: () => ({}),
    };

    assert.strictEqual(isConfigComponent(notConfig), false);
  });

  test('should return false for primitive values', () => {
    assert.strictEqual(isConfigComponent('string'), false);
    assert.strictEqual(isConfigComponent(123), false);
    assert.strictEqual(isConfigComponent(true), false);
  });

  test('should return false for arrays', () => {
    assert.strictEqual(isConfigComponent([]), false);
    assert.strictEqual(isConfigComponent([1, 2, 3]), false);
  });
});
