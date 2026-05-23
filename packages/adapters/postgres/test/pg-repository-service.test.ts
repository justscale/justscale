/**
 * Tests for createPgRepository service pattern
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import { defineModel, field } from '@justscale/core/models';
import { createPgModel, createPgRepository } from '../src/index.js';

// =============================================================================
// Test Models
// =============================================================================

class User extends defineModel({
  email: field.string().max(255).unique(),
  name: field.string(),
  age: field.int().optional(),
}) {}

const PgUser = createPgModel(User, {
  table: 'users',
  overrides: {
    email: { unique: true, index: true },
  },
});

// =============================================================================
// createPgRepository Tests
// =============================================================================

describe('createPgRepository', () => {
  test('returns a ServiceDef with correct structure', () => {
    const UserRepository = createPgRepository(PgUser);

    // ServiceDef has deps and factory
    assert.ok('deps' in UserRepository);
    assert.ok('factory' in UserRepository);

    // deps contains AbstractPostgresClient
    assert.ok('client' in UserRepository.deps);
  });

  test('infers the correct type from PgModel', () => {
    const UserRepository = createPgRepository(PgUser);

    // The type is Repository<{ email: string; name: string; age?: number }>
    // We can't easily test types at runtime, but we verify the structure
    assert.ok(UserRepository);
  });

  test('different models create different ServiceDefs', () => {
    class Post extends defineModel({
      title: field.string(),
      content: field.text(),
    }) {}

    const PgPost = createPgModel(Post, { table: 'posts' });

    const UserRepository = createPgRepository(PgUser);
    const PostRepository = createPgRepository(PgPost);

    // Different ServiceDefs
    assert.notStrictEqual(UserRepository, PostRepository);
  });

  test('ServiceDef can be used as a reference for injection', () => {
    const UserRepository = createPgRepository(PgUser);

    // In real usage, this would be used like:
    // defineService({
    //   inject: { users: UserRepository },
    //   factory: ({ users }) => ({ ... })
    // });

    // For this test, we just verify it's a valid Service token
    assert.ok(typeof UserRepository === 'function' || typeof UserRepository === 'object');
    assert.ok(typeof (UserRepository as { factory: unknown }).factory === 'function');
  });
});

// =============================================================================
// Integration Pattern Tests (verifies the DI pattern works)
// =============================================================================

describe('Repository DI Pattern', () => {
  test('example: defining a service that uses a repository', () => {
    // This test documents the intended usage pattern
    const UserRepository = createPgRepository(PgUser);

    // Simulate what defineService does
    const mockClient = {} as any; // Would be resolved by DI
    const mockChannels = {} as any; // Would be resolved by DI
    const resolvedDeps = { client: mockClient, channels: mockChannels };

    // Factory creates the repository
    const repository = UserRepository.factory(resolvedDeps, () => {
      throw new Error('resolve not needed');
    });

    // Repository has expected methods
    assert.ok(typeof repository.find === 'function');
    assert.ok(typeof repository.get === 'function');
    assert.ok(typeof repository.findOne === 'function');
    assert.ok(typeof repository.count === 'function');
    assert.ok(typeof repository.insert === 'function');
    assert.ok(typeof repository.update === 'function');
    assert.ok(typeof repository.delete === 'function');
  });
});
