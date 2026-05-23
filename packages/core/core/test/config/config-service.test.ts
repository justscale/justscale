/**
 * Tests for ConfigService
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Container } from '@justscale/core';
import { z } from 'zod';
import { createConfigService, type ConfigService } from '../../src/features/config/config-service.js';
import { defineConfigPartial, type ConfigPartial } from '../../src/features/config/index.js';
import { existsSync, rmSync, readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================================
// Test Fixtures
// ============================================================================

const TestConfigSchema = z.object({
  host: z.string(),
  port: z.number(),
  database: z.object({
    name: z.string(),
    maxConnections: z.number(),
  }),
});

type TestConfig = z.infer<typeof TestConfigSchema>;

const NestedConfigSchema = z.object({
  level1: z.object({
    level2: z.object({
      level3: z.object({
        value: z.string(),
      }),
    }),
  }),
});

type NestedConfig = z.infer<typeof NestedConfigSchema>;

// ============================================================================
// Test Setup
// ============================================================================

describe('ConfigService', () => {
  let container: Container;
  let configService: ConfigService;
  let testPartial: ConfigPartial<TestConfig>;
  let nestedPartial: ConfigPartial<NestedConfig>;
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    // Create unique temp directory for test isolation
    configDir = mkdtempSync(join(tmpdir(), 'config-service-test-'));
    configPath = join(configDir, 'config.json');

    // Create fresh container
    container = new Container();

    // Define test partials
    testPartial = defineConfigPartial('TestConfig', TestConfigSchema);
    nestedPartial = defineConfigPartial('NestedConfig', NestedConfigSchema);

    // Register test config instances
    const testConfig: TestConfig = {
      host: 'localhost',
      port: 5432,
      database: {
        name: 'testdb',
        maxConnections: 10,
      },
    };

    const nestedConfig: NestedConfig = {
      level1: {
        level2: {
          level3: {
            value: 'deep',
          },
        },
      },
    };

    container.registerInstance(testPartial.key as any, testConfig);
    container.registerInstance(nestedPartial.key as any, nestedConfig);

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

  // ============================================================================
  // set() - Update Values and Notify Watchers
  // ============================================================================

  describe('set()', () => {
    it('should update a top-level value', async () => {
      const count = await configService.set(testPartial, 'host', 'newhost');

      // Verify persistence
      assert.ok(existsSync(configPath));
      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(persisted.TestConfig.host, 'newhost');

      // No watchers registered, so count should be 0
      assert.strictEqual(count, 0);
    });

    it('should update a nested value', async () => {
      const count = await configService.set(testPartial, 'database.name', 'production');

      // Verify persistence
      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(persisted.TestConfig.database.name, 'production');
      assert.strictEqual(persisted.TestConfig.database.maxConnections, 10); // unchanged

      assert.strictEqual(count, 0);
    });

    it('should update deeply nested values', async () => {
      const count = await configService.set(nestedPartial, 'level1.level2.level3.value', 'updated');

      // Verify persistence
      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(persisted.NestedConfig.level1.level2.level3.value, 'updated');

      assert.strictEqual(count, 0);
    });

    it('should validate against schema and throw on invalid value', async () => {
      // Try to set port to a string (should fail validation)
      await assert.rejects(
        () => configService.set(testPartial, 'port', 'not-a-number'),
        /expected number|invalid_type/
      );
    });

    it('should validate nested values against schema', async () => {
      // Try to set database.maxConnections to a string (should fail)
      await assert.rejects(
        () => configService.set(testPartial, 'database.maxConnections', 'invalid'),
        /expected number|invalid_type/
      );
    });

    it('should return the number of watchers notified', async () => {
      // Set up watchers
      const watcher1 = configService.watch(testPartial);
      const watcher2 = configService.watch(testPartial);
      const watcher3 = configService.watch(testPartial);

      // Start watching (get iterators to register watchers)
      const iter1 = watcher1[Symbol.asyncIterator]();
      const iter2 = watcher2[Symbol.asyncIterator]();
      const iter3 = watcher3[Symbol.asyncIterator]();

      // Now set should notify all watchers
      const count = await configService.set(testPartial, 'host', 'updated');
      assert.strictEqual(count, 3);

      // Clean up iterators
      await iter1.return?.();
      await iter2.return?.();
      await iter3.return?.();
    });

    it('should notify watchers with old and new values', async () => {
      const watcher = configService.watch(testPartial);
      const iterator = watcher[Symbol.asyncIterator]();

      // Trigger a change
      const promise = iterator.next();
      await configService.set(testPartial, 'port', 3000);

      const result = await promise;
      assert.strictEqual(result.done, false);

      const [oldValue, newValue] = result.value;
      assert.strictEqual(oldValue.port, 5432); // original value
      assert.strictEqual(newValue.port, 3000); // new value

      await iterator.return?.();
    });

    it('should preserve unchanged nested values', async () => {
      await configService.set(testPartial, 'database.name', 'newdb');

      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));

      // Changed value
      assert.strictEqual(persisted.TestConfig.database.name, 'newdb');

      // Unchanged values
      assert.strictEqual(persisted.TestConfig.host, 'localhost');
      assert.strictEqual(persisted.TestConfig.port, 5432);
      assert.strictEqual(persisted.TestConfig.database.maxConnections, 10);
    });
  });

  // ============================================================================
  // watch() - Async Iterable for Changes
  // ============================================================================

  describe('watch()', () => {
    it('should yield [oldValue, newValue] pairs on changes', async () => {
      const watcher = configService.watch(testPartial);
      const iterator = watcher[Symbol.asyncIterator]();

      // Trigger first change and wait for it
      await configService.set(testPartial, 'host', 'host1');

      const result1 = await iterator.next();
      assert.strictEqual(result1.done, false);
      const [old1, new1] = result1.value;
      assert.strictEqual(old1.host, 'localhost');
      assert.strictEqual(new1.host, 'host1');

      // Note: The current implementation doesn't update the container,
      // so the second set() will also see oldValue as 'localhost' from the container.
      // This is a known limitation (see TODO in config-service.ts)
      await configService.set(testPartial, 'port', 9999);

      const result2 = await iterator.next();
      assert.strictEqual(result2.done, false);
      const [old2, new2] = result2.value;
      assert.strictEqual(old2.port, 5432); // original port from container
      assert.strictEqual(new2.port, 9999); // new port

      await iterator.return?.();
    });

    it('should only notify on path changes when path filter is provided', async () => {
      const watcher = configService.watch(testPartial, 'database.name');
      const iterator = watcher[Symbol.asyncIterator]();

      // Change database.name - should notify
      const promise1 = iterator.next();
      await configService.set(testPartial, 'database.name', 'newdb');

      const result1 = await promise1;
      assert.strictEqual(result1.done, false);
      const [old1, new1] = result1.value;
      assert.strictEqual(old1.database.name, 'testdb');
      assert.strictEqual(new1.database.name, 'newdb');

      // Change host - should NOT notify (different path)
      const promise2 = Promise.race([
        iterator.next(),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 100))
      ]);

      await configService.set(testPartial, 'host', 'otherhost');

      const result2 = await promise2;
      assert.ok((result2 as any).timeout, 'Should not notify for unrelated path change');

      await iterator.return?.();
    });

    it('should NOT notify when path value does not change', async () => {
      const watcher = configService.watch(testPartial, 'host');
      const iterator = watcher[Symbol.asyncIterator]();

      // Set host to same value - should NOT notify
      const promise = Promise.race([
        iterator.next(),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 100))
      ]);

      await configService.set(testPartial, 'host', 'localhost'); // same as current

      const result = await promise;
      assert.ok((result as any).timeout, 'Should not notify when value is unchanged');

      await iterator.return?.();
    });

    it('should notify when nested path changes', async () => {
      const watcher = configService.watch(testPartial, 'database');
      const iterator = watcher[Symbol.asyncIterator]();

      // Change database.name
      const promise = iterator.next();
      await configService.set(testPartial, 'database.name', 'changed');

      const result = await promise;
      assert.strictEqual(result.done, false);
      const [oldValue, newValue] = result.value;
      assert.strictEqual(oldValue.database.name, 'testdb');
      assert.strictEqual(newValue.database.name, 'changed');

      await iterator.return?.();
    });

    it('should support multiple independent watchers', async () => {
      const watcher1 = configService.watch(testPartial);
      const watcher2 = configService.watch(testPartial);

      const iter1 = watcher1[Symbol.asyncIterator]();
      const iter2 = watcher2[Symbol.asyncIterator]();

      // Both should receive the change
      const promise1 = iter1.next();
      const promise2 = iter2.next();

      await configService.set(testPartial, 'port', 9999);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      assert.strictEqual(result1.done, false);
      assert.strictEqual(result2.done, false);

      assert.strictEqual(result1.value[1].port, 9999);
      assert.strictEqual(result2.value[1].port, 9999);

      await iter1.return?.();
      await iter2.return?.();
    });

    it('should stop receiving updates after iterator.return()', async () => {
      const watcher = configService.watch(testPartial);
      const iterator = watcher[Symbol.asyncIterator]();

      // Receive one update
      const promise1 = iterator.next();
      await configService.set(testPartial, 'host', 'first');
      await promise1;

      // Stop watching
      await iterator.return?.();

      // Trigger another change
      const promise2 = Promise.race([
        iterator.next(),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 100))
      ]);

      await configService.set(testPartial, 'host', 'second');

      const result2 = await promise2;
      // Should either be done or timeout (not receive the update)
      assert.ok((result2 as any).timeout || (result2 as any).done);
    });
  });

  // ============================================================================
  // Path Utilities
  // ============================================================================

  describe('Path utilities (setPath/getPath integration)', () => {
    it('should handle single-level paths', async () => {
      await configService.set(testPartial, 'host', 'example.com');

      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(persisted.TestConfig.host, 'example.com');
    });

    it('should handle two-level paths', async () => {
      await configService.set(testPartial, 'database.name', 'mydb');

      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(persisted.TestConfig.database.name, 'mydb');
    });

    it('should handle three-level paths', async () => {
      await configService.set(nestedPartial, 'level1.level2.level3.value', 'triple-nested');

      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(persisted.NestedConfig.level1.level2.level3.value, 'triple-nested');
    });

    it('should create shallow copies at each level', async () => {
      // Get original config
      const original = await container.resolve<TestConfig>(testPartial.key as any) as TestConfig;
      const originalDatabase = original.database;

      // Update a nested value
      await configService.set(testPartial, 'database.name', 'newname');

      // Verify the persisted config has updated data
      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(persisted.TestConfig.database.name, 'newname');

      // Original object in memory should still have old reference
      // (ConfigService doesn't mutate the container directly in MVP)
      assert.strictEqual(original.database, originalDatabase);
    });
  });

  // ============================================================================
  // Multiple Watchers and Concurrency
  // ============================================================================

  describe('Multiple watchers', () => {
    it('should notify all watchers on a single change', async () => {
      const received: number[] = [];

      const watcher1 = configService.watch(testPartial);
      const watcher2 = configService.watch(testPartial);
      const watcher3 = configService.watch(testPartial);

      const iter1 = watcher1[Symbol.asyncIterator]();
      const iter2 = watcher2[Symbol.asyncIterator]();
      const iter3 = watcher3[Symbol.asyncIterator]();

      const promises = [
        iter1.next().then(() => received.push(1)),
        iter2.next().then(() => received.push(2)),
        iter3.next().then(() => received.push(3)),
      ];

      // Trigger change
      await configService.set(testPartial, 'port', 8080);

      await Promise.all(promises);

      // All three should have been notified
      assert.strictEqual(received.length, 3);
      assert.ok(received.includes(1));
      assert.ok(received.includes(2));
      assert.ok(received.includes(3));

      await iter1.return?.();
      await iter2.return?.();
      await iter3.return?.();
    });

    it('should handle watchers with different path filters', async () => {
      const hostWatcher = configService.watch(testPartial, 'host');
      const portWatcher = configService.watch(testPartial, 'port');
      const dbWatcher = configService.watch(testPartial, 'database.name');

      const hostIter = hostWatcher[Symbol.asyncIterator]();
      const portIter = portWatcher[Symbol.asyncIterator]();
      const dbIter = dbWatcher[Symbol.asyncIterator]();

      // Change host - only hostWatcher should be notified
      const hostPromise = hostIter.next();
      const portPromise = Promise.race([
        portIter.next(),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 100))
      ]);
      const dbPromise = Promise.race([
        dbIter.next(),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 100))
      ]);

      await configService.set(testPartial, 'host', 'changed');

      const [hostResult, portResult, dbResult] = await Promise.all([hostPromise, portPromise, dbPromise]);

      assert.strictEqual(hostResult.done, false);
      assert.ok((portResult as any).timeout);
      assert.ok((dbResult as any).timeout);

      await hostIter.return?.();
      await portIter.return?.();
      await dbIter.return?.();
    });
  });

  // ============================================================================
  // Persistence
  // ============================================================================

  describe('Persistence', () => {
    it('should create .justscale directory if it does not exist', async () => {
      // Clean up first
      if (existsSync(configDir)) {
        rmSync(configDir, { recursive: true, force: true });
      }

      await configService.set(testPartial, 'host', 'newhost');

      assert.ok(existsSync(configDir));
      assert.ok(existsSync(configPath));
    });

    it('should preserve existing config when updating a different partial', async () => {
      // Set test config
      await configService.set(testPartial, 'host', 'test-host');

      // Set nested config
      await configService.set(nestedPartial, 'level1.level2.level3.value', 'nested-value');

      // Verify both are persisted
      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(persisted.TestConfig.host, 'test-host');
      assert.strictEqual(persisted.NestedConfig.level1.level2.level3.value, 'nested-value');
    });

    it('should overwrite previous value when setting the same partial', async () => {
      await configService.set(testPartial, 'host', 'first');
      await configService.set(testPartial, 'host', 'second');

      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.strictEqual(persisted.TestConfig.host, 'second');
    });

    it('should handle JSON serialization correctly', async () => {
      await configService.set(testPartial, 'database.maxConnections', 100);

      const raw = readFileSync(configPath, 'utf-8');
      const persisted = JSON.parse(raw);

      // Verify it's valid JSON and properly formatted
      assert.ok(raw.includes('"TestConfig"'));
      assert.strictEqual(persisted.TestConfig.database.maxConnections, 100);
    });
  });
});
