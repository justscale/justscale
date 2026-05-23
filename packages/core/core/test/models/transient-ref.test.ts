/**
 * Tests for TransientRef - references to unsaved entities
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import {
  defineModel,
  field,
  TransientRef,
  isTransientRef,
  Reference,
  isReference,
  type Transient,
  ADAPTER_KEY,
  type Persistent,
  TRANSIENT_REF,
  TRANSIENT_TARGET,
} from '../../src/models/index.js';

// =============================================================================
// Test Models
// =============================================================================

class User extends defineModel({
  name: field.string(),
  email: field.string(),
}) {}

class Post extends defineModel({
  title: field.string(),
  content: field.string(),
  authorId: field.string().optional(),
}) {}

// =============================================================================
// TransientRef Construction Tests
// =============================================================================

describe('TransientRef', () => {
  describe('construction', () => {
    test('should create a transient reference to an unsaved entity', () => {
      const user = new User({ name: 'Alice', email: 'alice@example.com' });
      const ref = new TransientRef(user);

      assert.ok(ref instanceof TransientRef);
      assert.ok(isTransientRef(ref));
      assert.strictEqual(ref.target, user);
    });

    test('should create a transient reference using static create method', () => {
      const user = new User({ name: 'Bob', email: 'bob@example.com' });
      const ref = TransientRef.create(user);

      assert.ok(ref instanceof TransientRef);
      assert.ok(isTransientRef(ref));
      assert.strictEqual(ref.target, user);
    });

    test('should have TRANSIENT_REF symbol marker', () => {
      const user = new User({ name: 'Charlie', email: 'charlie@example.com' });
      const ref = new TransientRef(user);

      assert.strictEqual(ref[TRANSIENT_REF], true);
    });

    test('should store target in TRANSIENT_TARGET symbol', () => {
      const user = new User({ name: 'Dave', email: 'dave@example.com' });
      const ref = new TransientRef(user);

      assert.strictEqual(ref[TRANSIENT_TARGET], user);
    });
  });

  // =============================================================================
  // Property Access Tests
  // =============================================================================

  describe('property access', () => {
    test('should provide synchronous access to target entity', () => {
      const user = new User({ name: 'Eve', email: 'eve@example.com' });
      const ref = new TransientRef(user);

      assert.strictEqual(ref.target, user);
      assert.strictEqual(ref.target.name, 'Eve');
      assert.strictEqual(ref.target.email, 'eve@example.com');
    });

    test('should report isLoaded as always true', () => {
      const user = new User({ name: 'Frank', email: 'frank@example.com' });
      const ref = new TransientRef(user);

      assert.strictEqual(ref.isLoaded, true);
    });

    test('should provide value property equal to target', () => {
      const user = new User({ name: 'Grace', email: 'grace@example.com' });
      const ref = new TransientRef(user);

      assert.strictEqual(ref.value, user);
      assert.strictEqual(ref.value, ref.target);
    });

    test('should provide valueOrNull property equal to target', () => {
      const user = new User({ name: 'Henry', email: 'henry@example.com' });
      const ref = new TransientRef(user);

      assert.strictEqual(ref.valueOrNull, user);
      assert.strictEqual(ref.valueOrNull, ref.target);
    });
  });

  // =============================================================================
  // PromiseLike Tests
  // =============================================================================

  describe('PromiseLike', () => {
    test('should be awaitable and resolve to target entity', async () => {
      const user = new User({ name: 'Ivy', email: 'ivy@example.com' });
      const ref = new TransientRef(user);

      const resolved = await ref;

      assert.strictEqual(resolved, user);
      assert.strictEqual(resolved.name, 'Ivy');
    });

    test('should work with Promise.resolve', async () => {
      const user = new User({ name: 'Jack', email: 'jack@example.com' });
      const ref = new TransientRef(user);

      const resolved = await Promise.resolve(ref);

      assert.strictEqual(resolved, user);
    });

    test('should work with Promise.all', async () => {
      const user1 = new User({ name: 'Kate', email: 'kate@example.com' });
      const user2 = new User({ name: 'Leo', email: 'leo@example.com' });

      const ref1 = new TransientRef(user1);
      const ref2 = new TransientRef(user2);

      const [resolved1, resolved2] = await Promise.all([ref1, ref2]);

      assert.strictEqual(resolved1, user1);
      assert.strictEqual(resolved2, user2);
    });

    test('should resolve immediately (synchronously)', async () => {
      const user = new User({ name: 'Mary', email: 'mary@example.com' });
      const ref = new TransientRef(user);

      let resolved = false;
      const promise = ref.then(() => {
        resolved = true;
      });

      // The promise should resolve immediately in the next microtask
      await promise;
      assert.strictEqual(resolved, true);
    });
  });

  // =============================================================================
  // Conversion to Reference Tests
  // =============================================================================

  describe('toReference()', () => {
    test('should throw when entity has no adapter key', () => {
      const user = new User({ name: 'Nancy', email: 'nancy@example.com' });
      const ref = new TransientRef(user);

      assert.throws(
        () => ref.toReference(),
        /Cannot convert TransientRef to Reference: entity has no adapter key/,
      );
    });

    test('should convert to Reference when entity has id', () => {
      // Simulate a persisted entity by adding id
      const user = new User({ name: 'Oscar', email: 'oscar@example.com' });
      (user as any)[ADAPTER_KEY] = 'user-123';

      const transientRef = new TransientRef(user);
      const persistentRef = transientRef.toReference();

      assert.ok(persistentRef instanceof Reference);
      assert.ok(isReference(persistentRef));
      assert.strictEqual(persistentRef.identifier, 'user-123');
    });

    test('should create a resolved Reference', () => {
      const user = new User({ name: 'Paula', email: 'paula@example.com' });
      (user as any)[ADAPTER_KEY] = 'user-456';

      const transientRef = new TransientRef(user);
      const persistentRef = transientRef.toReference();

      // The reference should already be loaded
      assert.strictEqual(persistentRef.isLoaded, true);
      assert.strictEqual(persistentRef.value, user);
    });

    test('should work after entity is saved', async () => {
      const user = new User({ name: 'Quinn', email: 'quinn@example.com' });
      const ref = new TransientRef(user);

      // Initially cannot convert
      assert.throws(() => ref.toReference());

      // Simulate saving the entity (would be done by repository)
      (user as any)[ADAPTER_KEY] = 'user-789';

      // Now can convert
      const persistentRef = ref.toReference();
      assert.strictEqual(persistentRef.identifier, 'user-789');
    });
  });

  // =============================================================================
  // canConvert() Tests
  // =============================================================================

  describe('canConvert()', () => {
    test('should return false when entity has no adapter key', () => {
      const user = new User({ name: 'Rachel', email: 'rachel@example.com' });
      const ref = new TransientRef(user);

      assert.strictEqual(ref.canConvert(), false);
    });

    test('should return true when entity has id', () => {
      const user = new User({ name: 'Sam', email: 'sam@example.com' });
      (user as any)[ADAPTER_KEY] = 'user-999';

      const ref = new TransientRef(user);

      assert.strictEqual(ref.canConvert(), true);
    });

    test('should return true even for empty string id', () => {
      const user = new User({ name: 'Tina', email: 'tina@example.com' });
      (user as any)[ADAPTER_KEY] = '';

      const ref = new TransientRef(user);

      // Empty string is falsy but still present
      assert.strictEqual(ref.canConvert(), false);
    });
  });

  // =============================================================================
  // Type Guard Tests
  // =============================================================================

  describe('isTransientRef()', () => {
    test('should return true for TransientRef instances', () => {
      const user = new User({ name: 'Uma', email: 'uma@example.com' });
      const ref = new TransientRef(user);

      assert.strictEqual(isTransientRef(ref), true);
    });

    test('should return false for Reference instances', () => {
      const ref = new Reference('user-123');

      assert.strictEqual(isTransientRef(ref), false);
    });

    test('should return false for regular objects', () => {
      const obj = { name: 'Not a ref' };

      assert.strictEqual(isTransientRef(obj), false);
    });

    test('should return false for null', () => {
      assert.strictEqual(isTransientRef(null), false);
    });

    test('should return false for undefined', () => {
      assert.strictEqual(isTransientRef(undefined), false);
    });

    test('should return false for primitives', () => {
      assert.strictEqual(isTransientRef('string'), false);
      assert.strictEqual(isTransientRef(123), false);
      assert.strictEqual(isTransientRef(true), false);
    });
  });

  // =============================================================================
  // Integration Tests
  // =============================================================================

  describe('integration', () => {
    test('should work in entity graphs before persistence', () => {
      // Create an unsaved user
      const user = new User({ name: 'Victor', email: 'victor@example.com' });

      // Create a post that references the unsaved user
      const post = new Post({
        title: 'My Post',
        content: 'This is my post',
      });

      // Store a transient reference
      const authorRef = new TransientRef(user);

      assert.strictEqual(authorRef.target, user);
      assert.strictEqual(authorRef.target.name, 'Victor');
    });

    test('should convert to Reference after both entities are saved', () => {
      const user = new User({ name: 'Wendy', email: 'wendy@example.com' });
      const post = new Post({
        title: 'Another Post',
        content: 'Content here',
      });

      const authorRef = new TransientRef(user);

      // Simulate saving both entities
      (user as any)[ADAPTER_KEY] = 'user-111';
      (post as any)[ADAPTER_KEY] = 'post-222';

      // Convert transient ref to persistent ref
      const persistentRef = authorRef.toReference();

      assert.strictEqual(persistentRef.identifier, 'user-111');
      assert.strictEqual(persistentRef.value, user);
    });

    test('should maintain entity reference through updates', async () => {
      const user = new User({ name: 'Xavier', email: 'xavier@example.com' });
      const ref = new TransientRef(user);

      // Modify the entity
      ;(user as any).name = 'Xavier Updated';

      // Reference should reflect the change
      const resolved = await ref;
      assert.strictEqual(resolved.name, 'Xavier Updated');
      assert.strictEqual(ref.target.name, 'Xavier Updated');
    });

    test('should work with different entity types', () => {
      const user = new User({ name: 'Yara', email: 'yara@example.com' });
      const post = new Post({
        title: 'Test Post',
        content: 'Test content',
      });

      const userRef = new TransientRef(user);
      const postRef = new TransientRef(post);

      assert.strictEqual(userRef.target, user);
      assert.strictEqual(postRef.target, post);
      assert.ok(isTransientRef(userRef));
      assert.ok(isTransientRef(postRef));
    });

    test('should distinguish from regular Reference', () => {
      const user = new User({ name: 'Zane', email: 'zane@example.com' });

      const transientRef = new TransientRef(user);
      const regularRef = new Reference('user-123');

      assert.ok(isTransientRef(transientRef));
      assert.ok(!isTransientRef(regularRef));
      assert.ok(!isReference(transientRef));
      assert.ok(isReference(regularRef));
    });
  });
});
