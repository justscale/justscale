import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createFeatureBuilder,
  getFeatureMetadata,
  getFeatureRequirements,
} from '../src/builder/feature-builder.js';
import { isFeatureToken } from '../src/builder/types.js';
import { defineService } from '../src/core/service.js';

// ============================================================================
// Test Services
// ============================================================================

const DatabaseService = defineService({
  inject: {},
  factory: () => ({
    query: (sql: string) => Promise.resolve([]),
  }),
});

const CacheService = defineService({
  inject: {},
  factory: () => ({
    get: (key: string) => null,
    set: (key: string, value: unknown) => {},
  }),
});

const UserService = defineService({
  inject: { db: DatabaseService },
  factory: ({ db }) => ({
    findUser: (id: string) => db.query(`SELECT * FROM users WHERE id = '${id}'`),
  }),
});

const AuthService = defineService({
  inject: { users: UserService, cache: CacheService },
  factory: ({ users, cache }) => ({
    authenticate: async (token: string) => {
      const cached = cache.get(token);
      if (cached) return cached;
      return users.findUser('1');
    },
  }),
});

// ============================================================================
// Feature Builder Tests
// ============================================================================

describe('Feature Builder', () => {
  describe('createFeatureBuilder', () => {
    it('should create a feature builder', () => {
      const builder = createFeatureBuilder();
      assert.ok(builder);
      assert.ok(typeof builder.requires === 'function');
      assert.ok(typeof builder.name === 'function');
      assert.ok(typeof builder.provides === 'function');
    });

    it('should create a feature with no requirements', () => {
      const feature = createFeatureBuilder()
        .name('simple')
        .provides((b) => b.add(DatabaseService));

      assert.ok(isFeatureToken(feature));
      assert.strictEqual(getFeatureMetadata(feature).name, 'simple');
      assert.deepStrictEqual(getFeatureRequirements(feature), []);
    });

    it('should create a feature with service requirements', () => {
      const feature = createFeatureBuilder()
        .name('user-feature')
        .requires(DatabaseService)
        .provides((b) => b.add(UserService));

      assert.ok(isFeatureToken(feature));
      assert.deepStrictEqual(getFeatureRequirements(feature), [DatabaseService]);
    });

    it('should accumulate multiple requirements', () => {
      const feature = createFeatureBuilder()
        .requires(DatabaseService)
        .requires(CacheService)
        .provides((b) => b.add(UserService).add(AuthService));

      const requirements = getFeatureRequirements(feature);
      assert.strictEqual(requirements.length, 2);
      assert.ok(requirements.includes(DatabaseService));
      assert.ok(requirements.includes(CacheService));
    });
  });

  describe('Feature requires Feature', () => {
    it('should allow requiring another feature', () => {
      const DatabaseFeature = createFeatureBuilder()
        .name('database')
        .provides((b) => b.add(DatabaseService));

      const UserFeature = createFeatureBuilder()
        .name('user')
        .requires(DatabaseFeature)
        .provides((b) => b.add(UserService));

      assert.ok(isFeatureToken(UserFeature));
      const requirements = getFeatureRequirements(UserFeature);
      assert.strictEqual(requirements.length, 1);
      assert.strictEqual(requirements[0], DatabaseFeature);
    });

    it('should make required feature provides available (type-level)', () => {
      // This test verifies the type system works correctly.
      // If this compiles, the types are correct.
      const DatabaseFeature = createFeatureBuilder()
        .name('database')
        .provides((b) => b.add(DatabaseService));

      // UserFeature requires DatabaseFeature.
      // Inside provides(), DatabaseService should be available because
      // DatabaseFeature provides it.
      const UserFeature = createFeatureBuilder()
        .name('user')
        .requires(DatabaseFeature)
        .provides((b) => {
          // DatabaseService is available from DatabaseFeature's provides
          // UserService depends on DatabaseService
          return b.add(UserService);
        });

      assert.ok(isFeatureToken(UserFeature));
    });

    it('should allow chaining feature requirements', () => {
      const DatabaseFeature = createFeatureBuilder()
        .name('database')
        .provides((b) => b.add(DatabaseService));

      const CacheFeature = createFeatureBuilder()
        .name('cache')
        .provides((b) => b.add(CacheService));

      const AuthFeature = createFeatureBuilder()
        .name('auth')
        .requires(DatabaseFeature)
        .requires(CacheFeature)
        .provides((b) =>
          b
            .add(UserService) // depends on DatabaseService (from DatabaseFeature)
            .add(AuthService) // depends on UserService and CacheService (from CacheFeature)
        );

      const requirements = getFeatureRequirements(AuthFeature);
      assert.strictEqual(requirements.length, 2);
      assert.ok(requirements.includes(DatabaseFeature));
      assert.ok(requirements.includes(CacheFeature));
    });

    it('should allow mixing service and feature requirements', () => {
      const DatabaseFeature = createFeatureBuilder()
        .name('database')
        .provides((b) => b.add(DatabaseService));

      const AuthFeature = createFeatureBuilder()
        .name('auth')
        .requires(DatabaseFeature) // Feature requirement
        .requires(CacheService) // Direct service requirement
        .provides((b) =>
          b
            .add(UserService) // depends on DatabaseService (from feature)
            .add(AuthService) // depends on UserService and CacheService (direct)
        );

      const requirements = getFeatureRequirements(AuthFeature);
      assert.strictEqual(requirements.length, 2);
      assert.ok(requirements.includes(DatabaseFeature));
      assert.ok(requirements.includes(CacheService));
    });
  });

  describe('Lifecycle hooks', () => {
    it('should store onStart hook', () => {
      let startCalled = false;
      const feature = createFeatureBuilder()
        .onStart(async () => {
          startCalled = true;
        })
        .provides((b) => b.add(DatabaseService));

      const metadata = getFeatureMetadata(feature);
      assert.ok(metadata.onStart);
    });

    it('should store onStop hook', () => {
      const feature = createFeatureBuilder()
        .onStop(async () => {})
        .provides((b) => b.add(DatabaseService));

      const metadata = getFeatureMetadata(feature);
      assert.ok(metadata.onStop);
    });

    it('should store both hooks', () => {
      const feature = createFeatureBuilder()
        .onStart(async () => {})
        .onStop(async () => {})
        .provides((b) => b.add(DatabaseService));

      const metadata = getFeatureMetadata(feature);
      assert.ok(metadata.onStart);
      assert.ok(metadata.onStop);
    });
  });
});
