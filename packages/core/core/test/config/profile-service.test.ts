/**
 * Tests for ProfileService
 *
 * Comprehensive tests for profile management including:
 * - Active profile detection (env var, file, default)
 * - Profile switching
 * - Profile CRUD operations
 * - Profile comparison
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { ProfileServiceDef } from '../../src/features/config/profile-service.js';

// Mock resolver for factory calls
const mockResolve = () => { throw new Error('Should not be called'); };

// =============================================================================
// Test Fixtures
// =============================================================================

describe('ProfileService', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Create temp directory
    tempDir = join(process.cwd(), '.test-profiles-' + Date.now());
    mkdirSync(tempDir, { recursive: true });

    // Change to temp directory
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Save original env
    originalEnv = process.env.JUSTSCALE_PROFILE;
    delete process.env.JUSTSCALE_PROFILE;
  });

  afterEach(() => {
    // Restore env
    if (originalEnv !== undefined) {
      process.env.JUSTSCALE_PROFILE = originalEnv;
    } else {
      delete process.env.JUSTSCALE_PROFILE;
    }

    // Restore working directory
    process.chdir(originalCwd);

    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // =============================================================================
  // active() tests
  // =============================================================================

  describe('active()', () => {
    test('returns "local" by default', () => {
      const service = ProfileServiceDef.factory({}, mockResolve);
      assert.strictEqual(service.active(), 'local');
    });

    test('respects JUSTSCALE_PROFILE env var (highest priority)', () => {
      // Create .active-profile file
      mkdirSync('.justscale', { recursive: true });
      writeFileSync('.justscale/.active-profile', 'production');

      // Set env var (should override file)
      process.env.JUSTSCALE_PROFILE = 'staging';

      const service = ProfileServiceDef.factory({}, mockResolve);
      assert.strictEqual(service.active(), 'staging');
    });

    test('reads from .active-profile file when env var not set', () => {
      mkdirSync('.justscale', { recursive: true });
      writeFileSync('.justscale/.active-profile', 'production');

      const service = ProfileServiceDef.factory({}, mockResolve);
      assert.strictEqual(service.active(), 'production');
    });

    test('trims whitespace from .active-profile file', () => {
      mkdirSync('.justscale', { recursive: true });
      writeFileSync('.justscale/.active-profile', '  production  \n');

      const service = ProfileServiceDef.factory({}, mockResolve);
      assert.strictEqual(service.active(), 'production');
    });
  });

  // =============================================================================
  // use() tests
  // =============================================================================

  describe('use()', () => {
    test('writes profile name to .active-profile file', () => {
      // Create profile first
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/dev.json', '{}');

      const service = ProfileServiceDef.factory({}, mockResolve);
      service.use('dev');

      const content = readFileSync('.justscale/.active-profile', 'utf-8');
      assert.strictEqual(content, 'dev');
    });

    test('throws when switching to non-existent profile', () => {
      const service = ProfileServiceDef.factory({}, mockResolve);

      assert.throws(
        () => service.use('nonexistent'),
        /Profile 'nonexistent' does not exist/
      );
    });

    test('creates .justscale directory if it does not exist', () => {
      // Create profile directory without parent
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/dev.json', '{}');

      const service = ProfileServiceDef.factory({}, mockResolve);
      service.use('dev');

      assert.ok(existsSync('.justscale'));
      assert.ok(existsSync('.justscale/.active-profile'));
    });
  });

  // =============================================================================
  // list() tests
  // =============================================================================

  describe('list()', () => {
    test('returns empty array when profiles directory does not exist', () => {
      const service = ProfileServiceDef.factory({}, mockResolve);
      const profiles = service.list();

      assert.deepStrictEqual(profiles, []);
    });

    test('returns available profile names', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/local.json', '{}');
      writeFileSync('.justscale/profiles/dev.json', '{}');
      writeFileSync('.justscale/profiles/production.json', '{}');

      const service = ProfileServiceDef.factory({}, mockResolve);
      const profiles = service.list();

      assert.deepStrictEqual(profiles.sort(), ['dev', 'local', 'production']);
    });

    test('filters out non-JSON files', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/local.json', '{}');
      writeFileSync('.justscale/profiles/dev.json', '{}');
      writeFileSync('.justscale/profiles/readme.txt', 'readme');
      writeFileSync('.justscale/profiles/.gitignore', '*.log');

      const service = ProfileServiceDef.factory({}, mockResolve);
      const profiles = service.list();

      assert.deepStrictEqual(profiles.sort(), ['dev', 'local']);
    });
  });

  // =============================================================================
  // get() tests
  // =============================================================================

  describe('get()', () => {
    test('returns empty object when profile does not exist', () => {
      const service = ProfileServiceDef.factory({}, mockResolve);
      const config = service.get('nonexistent');

      assert.deepStrictEqual(config, {});
    });

    test('returns profile config values', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      const profileConfig = {
        database: { host: 'localhost', port: 5432 },
        api: { url: 'http://localhost:3000' }
      };
      writeFileSync('.justscale/profiles/dev.json', JSON.stringify(profileConfig));

      const service = ProfileServiceDef.factory({}, mockResolve);
      const config = service.get('dev');

      assert.deepStrictEqual(config, profileConfig);
    });

    test('returns empty object for invalid JSON', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/broken.json', 'invalid json {');

      const service = ProfileServiceDef.factory({}, mockResolve);
      const config = service.get('broken');

      assert.deepStrictEqual(config, {});
    });
  });

  // =============================================================================
  // create() tests
  // =============================================================================

  describe('create()', () => {
    test('creates new empty profile file', () => {
      const service = ProfileServiceDef.factory({}, mockResolve);
      service.create('staging');

      const profilePath = '.justscale/profiles/staging.json';
      assert.ok(existsSync(profilePath));

      const content = JSON.parse(readFileSync(profilePath, 'utf-8'));
      assert.deepStrictEqual(content, {});
    });

    test('creates profile with copyFrom values', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      const devConfig = {
        database: { host: 'localhost', port: 5432 },
        api: { url: 'http://localhost:3000' }
      };
      writeFileSync('.justscale/profiles/dev.json', JSON.stringify(devConfig));

      const service = ProfileServiceDef.factory({}, mockResolve);
      service.create('staging', 'dev');

      const content = JSON.parse(readFileSync('.justscale/profiles/staging.json', 'utf-8'));
      assert.deepStrictEqual(content, devConfig);
    });

    test('throws when profile already exists', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/existing.json', '{}');

      const service = ProfileServiceDef.factory({}, mockResolve);

      assert.throws(
        () => service.create('existing'),
        /Profile 'existing' already exists/
      );
    });

    test('throws when copyFrom profile does not exist', () => {
      const service = ProfileServiceDef.factory({}, mockResolve);

      assert.throws(
        () => service.create('new-profile', 'nonexistent'),
        /Source profile 'nonexistent' does not exist/
      );
    });

    test('creates directories if they do not exist', () => {
      const service = ProfileServiceDef.factory({}, mockResolve);
      service.create('new-profile');

      assert.ok(existsSync('.justscale'));
      assert.ok(existsSync('.justscale/profiles'));
      assert.ok(existsSync('.justscale/profiles/new-profile.json'));
    });

    test('formats JSON with proper indentation', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      const sourceConfig = { a: 1, b: { c: 2 } };
      writeFileSync('.justscale/profiles/source.json', JSON.stringify(sourceConfig));

      const service = ProfileServiceDef.factory({}, mockResolve);
      service.create('target', 'source');

      const content = readFileSync('.justscale/profiles/target.json', 'utf-8');
      assert.ok(content.includes('\n  ')); // Check for indentation
    });
  });

  // =============================================================================
  // delete() tests
  // =============================================================================

  describe('delete()', () => {
    test('removes profile file', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/old-profile.json', '{}');

      const service = ProfileServiceDef.factory({}, mockResolve);
      service.delete('old-profile');

      assert.ok(!existsSync('.justscale/profiles/old-profile.json'));
    });

    test('throws when deleting non-existent profile', () => {
      const service = ProfileServiceDef.factory({}, mockResolve);

      assert.throws(
        () => service.delete('nonexistent'),
        /Profile 'nonexistent' does not exist/
      );
    });

    test('throws when deleting active profile', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/dev.json', '{}');
      writeFileSync('.justscale/.active-profile', 'dev');

      const service = ProfileServiceDef.factory({}, mockResolve);

      assert.throws(
        () => service.delete('dev'),
        /Cannot delete active profile 'dev'/
      );
    });

    test('throws when deleting profile active via env var', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/dev.json', '{}');
      process.env.JUSTSCALE_PROFILE = 'dev';

      const service = ProfileServiceDef.factory({}, mockResolve);

      assert.throws(
        () => service.delete('dev'),
        /Cannot delete active profile 'dev'/
      );
    });

    test('allows deleting non-active profile', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/dev.json', '{}');
      writeFileSync('.justscale/profiles/staging.json', '{}');
      writeFileSync('.justscale/.active-profile', 'dev');

      const service = ProfileServiceDef.factory({}, mockResolve);
      service.delete('staging');

      assert.ok(!existsSync('.justscale/profiles/staging.json'));
      assert.ok(existsSync('.justscale/profiles/dev.json'));
    });
  });

  // =============================================================================
  // diff() tests
  // =============================================================================

  describe('diff()', () => {
    test('returns empty array when profiles are identical', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      const config = { a: 1, b: 2 };
      writeFileSync('.justscale/profiles/p1.json', JSON.stringify(config));
      writeFileSync('.justscale/profiles/p2.json', JSON.stringify(config));

      const service = ProfileServiceDef.factory({}, mockResolve);
      const diffs = service.diff('p1', 'p2');

      assert.deepStrictEqual(diffs, []);
    });

    test('returns differences between profiles', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      const dev = {
        database: { host: 'localhost', port: 5432 },
        api: { url: 'http://localhost:3000' }
      };
      const prod = {
        database: { host: 'prod.db.com', port: 5432 },
        api: { url: 'https://api.example.com' }
      };
      writeFileSync('.justscale/profiles/dev.json', JSON.stringify(dev));
      writeFileSync('.justscale/profiles/prod.json', JSON.stringify(prod));

      const service = ProfileServiceDef.factory({}, mockResolve);
      const diffs = service.diff('dev', 'prod');

      assert.strictEqual(diffs.length, 2);

      const dbDiff = diffs.find(d => d.key === 'database');
      assert.ok(dbDiff);
      assert.deepStrictEqual(dbDiff.from, { host: 'localhost', port: 5432 });
      assert.deepStrictEqual(dbDiff.to, { host: 'prod.db.com', port: 5432 });

      const apiDiff = diffs.find(d => d.key === 'api');
      assert.ok(apiDiff);
      assert.deepStrictEqual(apiDiff.from, { url: 'http://localhost:3000' });
      assert.deepStrictEqual(apiDiff.to, { url: 'https://api.example.com' });
    });

    test('detects keys only in source profile', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      const p1 = { a: 1, b: 2, onlyInP1: 'value' };
      const p2 = { a: 1, b: 2 };
      writeFileSync('.justscale/profiles/p1.json', JSON.stringify(p1));
      writeFileSync('.justscale/profiles/p2.json', JSON.stringify(p2));

      const service = ProfileServiceDef.factory({}, mockResolve);
      const diffs = service.diff('p1', 'p2');

      assert.strictEqual(diffs.length, 1);
      assert.strictEqual(diffs[0].key, 'onlyInP1');
      assert.strictEqual(diffs[0].from, 'value');
      assert.strictEqual(diffs[0].to, undefined);
    });

    test('detects keys only in target profile', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      const p1 = { a: 1, b: 2 };
      const p2 = { a: 1, b: 2, onlyInP2: 'value' };
      writeFileSync('.justscale/profiles/p1.json', JSON.stringify(p1));
      writeFileSync('.justscale/profiles/p2.json', JSON.stringify(p2));

      const service = ProfileServiceDef.factory({}, mockResolve);
      const diffs = service.diff('p1', 'p2');

      assert.strictEqual(diffs.length, 1);
      assert.strictEqual(diffs[0].key, 'onlyInP2');
      assert.strictEqual(diffs[0].from, undefined);
      assert.strictEqual(diffs[0].to, 'value');
    });

    test('handles non-existent profiles gracefully', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/p1.json', JSON.stringify({ a: 1 }));

      const service = ProfileServiceDef.factory({}, mockResolve);
      const diffs = service.diff('p1', 'nonexistent');

      assert.strictEqual(diffs.length, 1);
      assert.strictEqual(diffs[0].key, 'a');
      assert.strictEqual(diffs[0].from, 1);
      assert.strictEqual(diffs[0].to, undefined);
    });

    test('compares nested objects correctly', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      const p1 = { nested: { a: 1, b: 2 } };
      const p2 = { nested: { a: 1, b: 3 } };
      writeFileSync('.justscale/profiles/p1.json', JSON.stringify(p1));
      writeFileSync('.justscale/profiles/p2.json', JSON.stringify(p2));

      const service = ProfileServiceDef.factory({}, mockResolve);
      const diffs = service.diff('p1', 'p2');

      assert.strictEqual(diffs.length, 1);
      assert.strictEqual(diffs[0].key, 'nested');
      assert.deepStrictEqual(diffs[0].from, { a: 1, b: 2 });
      assert.deepStrictEqual(diffs[0].to, { a: 1, b: 3 });
    });

    test('compares arrays correctly', () => {
      mkdirSync('.justscale/profiles', { recursive: true });
      const p1 = { tags: ['a', 'b', 'c'] };
      const p2 = { tags: ['a', 'b', 'd'] };
      writeFileSync('.justscale/profiles/p1.json', JSON.stringify(p1));
      writeFileSync('.justscale/profiles/p2.json', JSON.stringify(p2));

      const service = ProfileServiceDef.factory({}, mockResolve);
      const diffs = service.diff('p1', 'p2');

      assert.strictEqual(diffs.length, 1);
      assert.strictEqual(diffs[0].key, 'tags');
      assert.deepStrictEqual(diffs[0].from, ['a', 'b', 'c']);
      assert.deepStrictEqual(diffs[0].to, ['a', 'b', 'd']);
    });
  });

  // =============================================================================
  // Integration tests
  // =============================================================================

  describe('Integration', () => {
    test('complete workflow: create, use, list, get, diff, delete', () => {
      const service = ProfileServiceDef.factory({}, mockResolve);

      // Start with local (default)
      assert.strictEqual(service.active(), 'local');

      // Create dev profile
      service.create('dev');
      const profiles = service.list();
      assert.ok(profiles.includes('dev'));

      // Switch to dev
      service.use('dev');
      assert.strictEqual(service.active(), 'dev');

      // Get dev config (should be empty)
      const config = service.get('dev');
      assert.deepStrictEqual(config, {});

      // Manually update dev file for diff test
      mkdirSync('.justscale/profiles', { recursive: true });
      writeFileSync('.justscale/profiles/dev.json', JSON.stringify({ env: 'dev' }));

      // Create staging from dev (now dev.json has content)
      service.create('staging', 'dev');

      // Manually update staging file for diff test
      writeFileSync('.justscale/profiles/staging.json', JSON.stringify({ env: 'staging' }));

      // Diff them
      const diffs = service.diff('dev', 'staging');
      assert.strictEqual(diffs.length, 1);
      assert.strictEqual(diffs[0].key, 'env');

      // Switch away from dev before deleting
      service.create('temp');
      service.use('temp');

      // Delete dev
      service.delete('dev');
      assert.ok(!service.list().includes('dev'));
    });

    test('multiple profiles with different configs', () => {
      mkdirSync('.justscale/profiles', { recursive: true });

      const localConfig = {
        database: { host: 'localhost', port: 5432 },
        redis: { host: 'localhost', port: 6379 }
      };

      const prodConfig = {
        database: { host: 'prod.db.com', port: 5432 },
        redis: { host: 'prod.redis.com', port: 6379 }
      };

      writeFileSync('.justscale/profiles/local.json', JSON.stringify(localConfig));
      writeFileSync('.justscale/profiles/production.json', JSON.stringify(prodConfig));

      const service = ProfileServiceDef.factory({}, mockResolve);

      // List should show both
      const profiles = service.list();
      assert.ok(profiles.includes('local'));
      assert.ok(profiles.includes('production'));

      // Get each config
      assert.deepStrictEqual(service.get('local'), localConfig);
      assert.deepStrictEqual(service.get('production'), prodConfig);

      // Diff should show differences
      const diffs = service.diff('local', 'production');
      assert.strictEqual(diffs.length, 2);
      assert.ok(diffs.some(d => d.key === 'database'));
      assert.ok(diffs.some(d => d.key === 'redis'));
    });
  });
});
