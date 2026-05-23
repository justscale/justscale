/**
 * Tests for In-Memory Repository
 *
 * Comprehensive tests for the in-memory repository implementation
 * including all condition types, sorting, and aggregations.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  defineModel,
  field,
  q,
  InMemoryRepository,
  createInMemoryModel,
  getModelFields,

} from '../../src/models/index.js';
import { MEM_CREATED_AT, MEM_UPDATED_AT, MEM_VERSION } from '../../src/models/in-memory/in-memory-repository.js';
import { ADAPTER_KEY } from '../../src/models/symbols.js';

// =============================================================================
// Test Models
// =============================================================================

class User extends defineModel({
  email: field.string().max(255),
  name: field.string(),
  age: field.int(),
  balance: field.decimal(10, 2),
  active: field.boolean(),
  role: field.enum('UserRole', ['admin', 'user', 'guest'] as const),
  tags: field.array(field.string()),
  settings: field.object({
    theme: field.string(),
    darkMode: field.boolean(),
    notifications: field.object({
      email: field.boolean(),
      push: field.boolean(),
    }),
  }),
}) {}

class Post extends defineModel({
  title: field.string().max(255),
  content: field.text(),
  views: field.int().default(0),
  rating: field.decimal(3, 2).optional(),
  published: field.boolean().default(false),
  author: field.ref(User),
}) {}

// =============================================================================
// Basic CRUD Tests
// =============================================================================

describe('InMemoryRepository - CRUD', () => {
  let repo: InMemoryRepository<User>;

  beforeEach(() => {
    repo = new InMemoryRepository();
  });

  test('insert() creates entity with adapter-internal system fields', async () => {
    const user = await repo.insert({
      email: 'test@example.com',
      name: 'Test User',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: ['developer'],
      settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    const sys = user as unknown as Record<symbol, unknown>;
    assert.ok(sys[ADAPTER_KEY]);
    assert.ok(sys[MEM_CREATED_AT] instanceof Date);
    assert.ok(sys[MEM_UPDATED_AT] instanceof Date);
    assert.strictEqual(sys[MEM_VERSION], 1);
    assert.strictEqual(user.email, 'test@example.com');
    assert.strictEqual(user.name, 'Test User');
    // System fields should NOT be enumerable (invisible to domain)
    assert.strictEqual('id' in user, false);
    assert.strictEqual('createdAt' in user, false);
  });

  test('insertMany() creates multiple entities', async () => {
    const users = await repo.insertMany([
      { email: 'a@test.com', name: 'A', age: 20, balance: '10.00', active: true, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'b@test.com', name: 'B', age: 30, balance: '20.00', active: false, role: 'admin', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
    ]);

    assert.strictEqual(users.length, 2);
    assert.strictEqual(users[0].email, 'a@test.com');
    assert.strictEqual(users[1].email, 'b@test.com');
  });

  test('get() returns entity or undefined', async () => {
    const user = await repo.insert({
      email: 'test@example.com',
      name: 'Test',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    const key = (user as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string;
    const found = await repo.get(User.ref(key));
    assert.strictEqual(found?.email, 'test@example.com');

    const notFound = await repo.get(User.ref('nonexistent'));
    assert.strictEqual(notFound, undefined);
  });

  test('update() modifies entity and increments version', async () => {
    const user = await repo.insert({
      email: 'test@example.com',
      name: 'Test',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    // update() requires a Locked<T> entity
    const locked = await repo.lock(user);
    assert.ok(locked);
    const updated = await repo.update(locked!, { name: 'Updated Name', age: 26 });
    const updatedSys = updated as unknown as Record<symbol, unknown>;

    assert.strictEqual(updated.name, 'Updated Name');
    assert.strictEqual(updated.age, 26);
    assert.strictEqual(updated.email, 'test@example.com'); // unchanged
    assert.strictEqual(updatedSys[MEM_VERSION], 2);
    assert.ok((updatedSys[MEM_UPDATED_AT] as Date) >= ((user as unknown as Record<symbol, unknown>)[MEM_UPDATED_AT] as Date));
  });

  test('update() requires locked entity', async () => {
    const user = await repo.insert({
      email: 'test@example.com',
      name: 'Test',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    // Lock and update — block-scoped so the first lock releases before
    // the second one acquires.
    let updated: typeof user;
    {
      await using locked = await repo.lock(user);
      assert.ok(locked);
      updated = await repo.update(locked!, { name: 'V1' });
      assert.strictEqual((updated as unknown as Record<symbol, unknown>)[MEM_VERSION], 2);
    }

    // Lock again and update again
    await using locked2 = await repo.lock(updated);
    assert.ok(locked2);
    const updated2 = await repo.update(locked2!, { name: 'V2' });
    assert.strictEqual((updated2 as unknown as Record<symbol, unknown>)[MEM_VERSION], 3);
    assert.strictEqual(updated2.name, 'V2');
  });

  test('save() inserts transient or updates locked', async () => {
    // Insert new via save (transient)
    const user = await repo.insert({
      email: 'test@example.com',
      name: 'Test',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    const sys = user as unknown as Record<symbol, unknown>;
    assert.ok(sys[ADAPTER_KEY]);
    assert.strictEqual(sys[MEM_VERSION], 1);

    // Update existing — save requires a Locked<T> for update path
    const locked = await repo.lock(user);
    assert.ok(locked);
    const updated = await repo.save(locked!);
    const updatedSys = updated as unknown as Record<symbol, unknown>;
    assert.strictEqual(updatedSys[ADAPTER_KEY], sys[ADAPTER_KEY]);
    assert.strictEqual(updatedSys[MEM_VERSION], 2);
  });

  test('delete() removes locked entity', async () => {
    const user = await repo.insert({
      email: 'test@example.com',
      name: 'Test',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    // delete() requires a Locked<T> entity
    const locked = await repo.lock(user);
    assert.ok(locked);
    const deleted = await repo.delete(locked!);
    assert.strictEqual(deleted, true);

    const key = (user as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string;
    const found = await repo.get(User.ref(key));
    assert.strictEqual(found, undefined);
  });
});

// =============================================================================
// Query Condition Tests
// =============================================================================

describe('InMemoryRepository - Conditions', () => {
  let repo: InMemoryRepository<User>;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    const settings = { theme: 'light', darkMode: false, notifications: { email: true, push: false } };
    await repo.insertMany([
      { email: 'alice@test.com', name: 'Alice', age: 25, balance: '100.00', active: true, role: 'admin', tags: ['dev'], settings },
      { email: 'bob@test.com', name: 'Bob', age: 30, balance: '200.00', active: true, role: 'user', tags: ['qa'], settings },
      { email: 'charlie@test.com', name: 'Charlie', age: 35, balance: '50.00', active: false, role: 'user', tags: ['dev', 'qa'], settings },
      { email: 'diana@test.com', name: 'Diana', age: 28, balance: '150.00', active: true, role: 'guest', tags: [], settings },
    ]);
  });

  test('eq() matches exact value', async () => {
    const results = await repo.find({ where: User.fields.email.eq('alice@test.com') });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'Alice');
  });

  test('neq() matches non-equal values', async () => {
    const results = await repo.find({ where: User.fields.role.neq('user') });
    assert.strictEqual(results.length, 2); // admin and guest
  });

  test('gt() matches greater than', async () => {
    const results = await repo.find({ where: User.fields.age.gt(28) });
    assert.strictEqual(results.length, 2); // Bob (30) and Charlie (35)
  });

  test('gte() matches greater than or equal', async () => {
    const results = await repo.find({ where: User.fields.age.gte(28) });
    assert.strictEqual(results.length, 3); // Diana (28), Bob (30), Charlie (35)
  });

  test('lt() matches less than', async () => {
    const results = await repo.find({ where: User.fields.age.lt(28) });
    assert.strictEqual(results.length, 1); // Alice (25)
  });

  test('lte() matches less than or equal', async () => {
    const results = await repo.find({ where: User.fields.age.lte(28) });
    assert.strictEqual(results.length, 2); // Alice (25), Diana (28)
  });

  test('between() matches range', async () => {
    const results = await repo.find({ where: User.fields.age.between(26, 32) });
    assert.strictEqual(results.length, 2); // Diana (28), Bob (30)
  });

  test('in() matches list of values', async () => {
    const results = await repo.find({ where: User.fields.role.in(['admin', 'guest']) });
    assert.strictEqual(results.length, 2);
  });

  test('notIn() excludes list of values', async () => {
    const results = await repo.find({ where: User.fields.role.notIn(['admin', 'guest']) });
    assert.strictEqual(results.length, 2); // only 'user' role
  });

  test('startsWith() matches prefix', async () => {
    const results = await repo.find({ where: User.fields.email.startsWith('alice') });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'Alice');
  });

  test('endsWith() matches suffix', async () => {
    const results = await repo.find({ where: User.fields.email.endsWith('@test.com') });
    assert.strictEqual(results.length, 4);
  });

  test('contains() matches substring', async () => {
    const results = await repo.find({ where: User.fields.name.contains('li') });
    assert.strictEqual(results.length, 2); // Alice, Charlie
  });

  test('like() matches SQL LIKE pattern', async () => {
    const results = await repo.find({ where: User.fields.name.like('_____') });
    assert.strictEqual(results.length, 2); // Alice, Diana (5 chars)
  });

  test('ilike() matches case-insensitive', async () => {
    const results = await repo.find({ where: User.fields.name.ilike('ALICE') });
    assert.strictEqual(results.length, 1);
  });

  test('isNull() matches null/undefined', async () => {
    // Add a user with null email
    await repo.insert({
      email: null as unknown as string,
      name: 'Null User',
      age: 20,
      balance: '0.00',
      active: true,
      role: 'guest',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    const results = await repo.find({ where: User.fields.email.isNull() });
    assert.strictEqual(results.length, 1);
  });

  test('isNotNull() matches non-null', async () => {
    const results = await repo.find({ where: User.fields.email.isNotNull() });
    assert.strictEqual(results.length, 4);
  });

  test('boolean isTrue() and isFalse()', async () => {
    const active = await repo.find({ where: User.fields.active.isTrue() });
    assert.strictEqual(active.length, 3);

    const inactive = await repo.find({ where: User.fields.active.isFalse() });
    assert.strictEqual(inactive.length, 1);
    assert.strictEqual(inactive[0].name, 'Charlie');
  });

  test('q.and() combines conditions', async () => {
    const results = await repo.find({
      where: q.and(
        User.fields.active.isTrue(),
        User.fields.age.gte(28),
      ),
    });
    assert.strictEqual(results.length, 2); // Bob (30) and Diana (28)
  });

  test('q.or() matches any condition', async () => {
    const results = await repo.find({
      where: q.or(
        User.fields.role.eq('admin'),
        User.fields.role.eq('guest'),
      ),
    });
    assert.strictEqual(results.length, 2);
  });

  test('q.not() negates condition', async () => {
    const results = await repo.find({
      where: q.not(User.fields.active.isTrue()),
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'Charlie');
  });

  test('complex nested conditions', async () => {
    const results = await repo.find({
      where: q.and(
        User.fields.active.isTrue(),
        q.or(
          User.fields.role.eq('admin'),
          q.and(
            User.fields.role.eq('user'),
            User.fields.age.gt(28),
          ),
        ),
      ),
    });
    // Alice (admin, active) and Bob (user, active, age > 28)
    assert.strictEqual(results.length, 2);
    const names = results.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ['Alice', 'Bob']);
  });
});

// =============================================================================
// Sorting Tests
// =============================================================================

describe('InMemoryRepository - Sorting', () => {
  let repo: InMemoryRepository<User>;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    await repo.insertMany([
      { email: 'c@test.com', name: 'Charlie', age: 35, balance: '50.00', active: false, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'a@test.com', name: 'Alice', age: 25, balance: '100.00', active: true, role: 'admin', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'b@test.com', name: 'Bob', age: 30, balance: '200.00', active: true, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
    ]);
  });

  test('orderBy with field expressions ascending', async () => {
    const results = await repo.find({
      orderBy: [User.fields.name.asc()],
    });
    assert.strictEqual(results[0].name, 'Alice');
    assert.strictEqual(results[1].name, 'Bob');
    assert.strictEqual(results[2].name, 'Charlie');
  });

  test('orderBy with field expressions descending', async () => {
    const results = await repo.find({
      orderBy: [User.fields.age.desc()],
    });
    assert.strictEqual(results[0].age, 35); // Charlie
    assert.strictEqual(results[1].age, 30); // Bob
    assert.strictEqual(results[2].age, 25); // Alice
  });

  test('orderBy with object form', async () => {
    const results = await repo.find({
      orderBy: { name: 'asc' },
    });
    assert.strictEqual(results[0].name, 'Alice');
    assert.strictEqual(results[2].name, 'Charlie');
  });

  test('orderBy with multiple fields', async () => {
    // Add users with same age
    await repo.insert({ email: 'd@test.com', name: 'Diana', age: 25, balance: '0.00', active: true, role: 'guest', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } });

    const results = await repo.find({
      orderBy: [User.fields.age.asc(), User.fields.name.desc()],
    });
    // Age 25: Diana, Alice (desc by name)
    // Age 30: Bob
    // Age 35: Charlie
    assert.strictEqual(results[0].name, 'Diana');
    assert.strictEqual(results[1].name, 'Alice');
    assert.strictEqual(results[2].name, 'Bob');
  });
});

// =============================================================================
// Pagination Tests
// =============================================================================

describe('InMemoryRepository - Pagination', () => {
  let repo: InMemoryRepository<User>;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    const users = Array.from({ length: 10 }, (_, i) => ({
      email: `user${i}@test.com`,
      name: `User ${i}`,
      age: 20 + i,
      balance: '0.00',
      active: true,
      role: 'user' as const,
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    }));
    await repo.insertMany(users);
  });

  test('limit restricts results', async () => {
    const results = await repo.find({ limit: 3 });
    assert.strictEqual(results.length, 3);
  });

  test('offset skips results', async () => {
    const results = await repo.find({
      orderBy: { age: 'asc' },
      offset: 5,
    });
    assert.strictEqual(results.length, 5);
    assert.strictEqual(results[0].age, 25);
  });

  test('limit and offset together', async () => {
    const results = await repo.find({
      orderBy: { age: 'asc' },
      limit: 3,
      offset: 2,
    });
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].age, 22);
    assert.strictEqual(results[2].age, 24);
  });
});

// =============================================================================
// Aggregation Tests
// =============================================================================

describe('InMemoryRepository - Aggregations', () => {
  let repo: InMemoryRepository<User>;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    await repo.insertMany([
      { email: 'a@test.com', name: 'Alice', age: 25, balance: '100.00', active: true, role: 'admin', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'b@test.com', name: 'Bob', age: 30, balance: '200.00', active: true, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'c@test.com', name: 'Charlie', age: 35, balance: '50.00', active: false, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'd@test.com', name: 'Diana', age: 28, balance: '150.00', active: true, role: 'guest', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
    ]);
  });

  test('count() counts all entities', async () => {
    const count = await repo.aggregate(q.count());
    assert.strictEqual(count, 4);
  });

  test('count() with condition', async () => {
    const count = await repo.aggregate(
      q.count(),
      User.fields.active.isTrue(),
    );
    assert.strictEqual(count, 3);
  });

  test('sum() sums field values', async () => {
    const sum = await repo.aggregate(q.sum(User.fields.age));
    assert.strictEqual(sum, 25 + 30 + 35 + 28);
  });

  test('avg() averages field values', async () => {
    const avg = await repo.aggregate(q.avg(User.fields.age));
    assert.strictEqual(avg, (25 + 30 + 35 + 28) / 4);
  });

  test('min() finds minimum', async () => {
    const min = await repo.aggregate(q.min(User.fields.age));
    assert.strictEqual(min, 25);
  });

  test('max() finds maximum', async () => {
    const max = await repo.aggregate(q.max(User.fields.age));
    assert.strictEqual(max, 35);
  });

  test('aggregation with condition', async () => {
    const avgActive = await repo.aggregate(
      q.avg(User.fields.age),
      User.fields.active.isTrue(),
    );
    // Alice (25), Bob (30), Diana (28) = 83/3 = 27.666...
    assert.ok(Math.abs(avgActive! - 27.666) < 0.01);
  });
});

// =============================================================================
// Streaming Tests
// =============================================================================

describe('InMemoryRepository - Streaming', () => {
  let repo: InMemoryRepository<User>;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    const users = Array.from({ length: 10 }, (_, i) => ({
      email: `user${i}@test.com`,
      name: `User ${i}`,
      age: 20 + i,
      balance: '0.00',
      active: true,
      role: 'user' as const,
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    }));
    await repo.insertMany(users);
  });

  test('stream() yields entities one at a time', async () => {
    const results: unknown[] = [];
    for await (const entity of repo.stream({ orderBy: { age: 'asc' } })) {
      results.push(entity);
    }
    assert.strictEqual(results.length, 10);
  });

  test('streamBatches() yields batches', async () => {
    const batches: unknown[][] = [];
    for await (const batch of repo.streamBatches({ batchSize: 3 })) {
      batches.push(batch);
    }
    assert.strictEqual(batches.length, 4); // 3 + 3 + 3 + 1
    assert.strictEqual(batches[0].length, 3);
    assert.strictEqual(batches[3].length, 1);
  });
});

// =============================================================================
// createInMemoryModel Tests
// =============================================================================

describe('createInMemoryModel', () => {
  test('creates model wrapper with repository factory', async () => {
    const MemoryUser = createInMemoryModel(User);

    assert.strictEqual(MemoryUser.name, 'User');
    assert.ok(MemoryUser.fields);

    const repo = MemoryUser.repository();
    assert.ok(repo instanceof InMemoryRepository);

    const user = await repo.insert({
      email: 'test@example.com',
      name: 'Test',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });
    assert.ok((user as unknown as Record<symbol, unknown>)[ADAPTER_KEY]);
  });

  test('sharedRepository returns same instance', () => {
    const MemoryUser = createInMemoryModel(User);

    const repo1 = MemoryUser.sharedRepository();
    const repo2 = MemoryUser.sharedRepository();

    assert.strictEqual(repo1, repo2);
  });

  test('resetSharedRepository clears instance', async () => {
    const MemoryUser = createInMemoryModel(User);

    const repo1 = MemoryUser.sharedRepository();
    await repo1.insert({
      email: 'test@example.com',
      name: 'Test',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    MemoryUser.resetSharedRepository();

    const repo2 = MemoryUser.sharedRepository();
    assert.notStrictEqual(repo1, repo2);
    assert.strictEqual(repo2.size, 0);
  });

  test('custom idGenerator', async () => {
    let counter = 0;
    const MemoryUser = createInMemoryModel(User, {
      idGenerator: () => `custom-${++counter}`,
    });

    const repo = MemoryUser.repository();
    const user = await repo.insert({
      email: 'test@example.com',
      name: 'Test',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    assert.strictEqual((user as unknown as Record<symbol, unknown>)[ADAPTER_KEY], 'custom-1');
  });

  test('repository with initial data', async () => {
    const MemoryUser = createInMemoryModel(User);
    const repo = MemoryUser.repository({
      initialData: [
        { email: 'a@test.com', name: 'A', age: 20, balance: '0.00', active: true, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
        { email: 'b@test.com', name: 'B', age: 30, balance: '0.00', active: true, role: 'admin', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      ],
    });

    assert.strictEqual(repo.size, 2);
    const all = await repo.find({});
    assert.strictEqual(all.length, 2);
  });
});

// =============================================================================
// Utility Method Tests
// =============================================================================

describe('InMemoryRepository - Utility Methods', () => {
  test('clear() removes all entities', async () => {
    const repo = new InMemoryRepository<User>();
    await repo.insertMany([
      { email: 'a@test.com', name: 'A', age: 20, balance: '0.00', active: true, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'b@test.com', name: 'B', age: 30, balance: '0.00', active: true, role: 'admin', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
    ]);

    assert.strictEqual(repo.size, 2);
    repo.clear();
    assert.strictEqual(repo.size, 0);
  });

  test('snapshot() and restore()', async () => {
    const repo = new InMemoryRepository<User>();
    await repo.insert({
      email: 'original@test.com',
      name: 'Original',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    const snapshot = repo.snapshot();

    // Modify repository
    repo.clear();
    await repo.insert({
      email: 'new@test.com',
      name: 'New',
      age: 30,
      balance: '0.00',
      active: true,
      role: 'admin',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    // Restore
    repo.restore(snapshot);

    const users = await repo.find({});
    assert.strictEqual(users.length, 1);
    assert.strictEqual(users[0].email, 'original@test.com');
  });

  test('deleteWhere() removes matching entities', async () => {
    const repo = new InMemoryRepository<User>();
    await repo.insertMany([
      { email: 'a@test.com', name: 'A', age: 20, balance: '0.00', active: true, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'b@test.com', name: 'B', age: 30, balance: '0.00', active: false, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'c@test.com', name: 'C', age: 40, balance: '0.00', active: true, role: 'admin', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
    ]);

    const deleted = await repo.deleteWhere(User.fields.active.isFalse());
    assert.strictEqual(deleted, 1);
    assert.strictEqual(repo.size, 2);
  });

  test('count() without condition', async () => {
    const repo = new InMemoryRepository<User>();
    await repo.insertMany([
      { email: 'a@test.com', name: 'A', age: 20, balance: '0.00', active: true, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'b@test.com', name: 'B', age: 30, balance: '0.00', active: true, role: 'admin', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
    ]);

    const count = await repo.count();
    assert.strictEqual(count, 2);
  });

  test('exists() checks for matching entity', async () => {
    const repo = new InMemoryRepository<User>();
    await repo.insert({
      email: 'exists@test.com',
      name: 'Exists',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'user',
      tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } },
    });

    const exists = await repo.exists(User.fields.email.eq('exists@test.com'));
    assert.strictEqual(exists, true);

    const notExists = await repo.exists(User.fields.email.eq('nope@test.com'));
    assert.strictEqual(notExists, false);
  });
});

// =============================================================================
// Date/Timestamp Tests
// =============================================================================

describe('InMemoryRepository - Date Conditions', () => {
  class Event extends defineModel({
    name: field.string(),
    scheduledAt: field.timestamp(),
  }) {}

  test('date comparisons work correctly', async () => {
    const repo = new InMemoryRepository<Event>();
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    await repo.insertMany([
      { name: 'Past Event', scheduledAt: yesterday },
      { name: 'Today Event', scheduledAt: now },
      { name: 'Future Event', scheduledAt: tomorrow },
    ]);

    const past = await repo.find({ where: Event.fields.scheduledAt.before(now) });
    assert.strictEqual(past.length, 1);
    assert.strictEqual(past[0].name, 'Past Event');

    const future = await repo.find({ where: Event.fields.scheduledAt.after(now) });
    assert.strictEqual(future.length, 1);
    assert.strictEqual(future[0].name, 'Future Event');

    const range = await repo.find({
      where: Event.fields.scheduledAt.between(yesterday, tomorrow),
    });
    assert.strictEqual(range.length, 3);
  });
});

// =============================================================================
// Array Field Condition Tests
// =============================================================================

describe('InMemoryRepository - Array Conditions', () => {
  let repo: InMemoryRepository<User>;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    const settings = { theme: 'light', darkMode: false, notifications: { email: true, push: false } };
    await repo.insertMany([
      { email: 'alice@test.com', name: 'Alice', age: 25, balance: '100.00', active: true, role: 'admin', tags: ['dev', 'typescript'], settings },
      { email: 'bob@test.com', name: 'Bob', age: 30, balance: '200.00', active: true, role: 'user', tags: ['qa', 'python'], settings },
      { email: 'charlie@test.com', name: 'Charlie', age: 35, balance: '50.00', active: false, role: 'user', tags: ['dev', 'qa', 'nodejs'], settings },
      { email: 'diana@test.com', name: 'Diana', age: 28, balance: '150.00', active: true, role: 'guest', tags: [], settings },
    ]);
  });

  test('array contains() matches single value', async () => {
    const results = await repo.find({ where: User.fields.tags.contains('dev') });
    assert.strictEqual(results.length, 2); // Alice and Charlie
    const names = results.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ['Alice', 'Charlie']);
  });

  test('array contains() returns false for non-match', async () => {
    const results = await repo.find({ where: User.fields.tags.contains('rust') });
    assert.strictEqual(results.length, 0);
  });

  test('array hasAny() matches if any value present', async () => {
    const results = await repo.find({ where: User.fields.tags.hasAny(['typescript', 'python']) });
    assert.strictEqual(results.length, 2); // Alice (typescript) and Bob (python)
    const names = results.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ['Alice', 'Bob']);
  });

  test('array hasAny() returns false for no match', async () => {
    const results = await repo.find({ where: User.fields.tags.hasAny(['rust', 'go']) });
    assert.strictEqual(results.length, 0);
  });

  test('array hasAll() matches if all values present', async () => {
    const results = await repo.find({ where: User.fields.tags.hasAll(['dev', 'qa']) });
    assert.strictEqual(results.length, 1); // Only Charlie has both
    assert.strictEqual(results[0].name, 'Charlie');
  });

  test('array hasAll() returns false if any value missing', async () => {
    const results = await repo.find({ where: User.fields.tags.hasAll(['dev', 'rust']) });
    assert.strictEqual(results.length, 0);
  });

  test('array overlaps() matches if any overlap', async () => {
    const results = await repo.find({ where: User.fields.tags.overlaps(['typescript', 'rust']) });
    assert.strictEqual(results.length, 1); // Only Alice has typescript
    assert.strictEqual(results[0].name, 'Alice');
  });

  test('array conditions combined with other conditions', async () => {
    const results = await repo.find({
      where: q.and(
        User.fields.active.isTrue(),
        User.fields.tags.contains('dev'),
      ),
    });
    assert.strictEqual(results.length, 1); // Alice (active and has dev)
    assert.strictEqual(results[0].name, 'Alice');
  });

  test('empty array does not match contains', async () => {
    const results = await repo.find({ where: User.fields.tags.contains('any') });
    // Diana has empty tags array, should not match
    assert.ok(!results.some((r) => r.name === 'Diana'));
  });
});

// =============================================================================
// Nested Object Field Condition Tests
// =============================================================================

describe('InMemoryRepository - Nested Object Conditions', () => {
  let repo: InMemoryRepository<User>;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    await repo.insertMany([
      { email: 'alice@test.com', name: 'Alice', age: 25, balance: '100.00', active: true, role: 'admin', tags: [], settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: true } } },
      { email: 'bob@test.com', name: 'Bob', age: 30, balance: '200.00', active: true, role: 'user', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: true, push: false } } },
      { email: 'charlie@test.com', name: 'Charlie', age: 35, balance: '50.00', active: false, role: 'user', tags: [], settings: { theme: 'dark', darkMode: true, notifications: { email: false, push: true } } },
      { email: 'diana@test.com', name: 'Diana', age: 28, balance: '150.00', active: true, role: 'guest', tags: [], settings: { theme: 'light', darkMode: false, notifications: { email: false, push: false } } },
    ]);
  });

  test('nested field eq() - single level', async () => {
    const results = await repo.find({ where: User.fields.settings.theme.eq('dark') });
    assert.strictEqual(results.length, 2); // Alice and Charlie
    const names = results.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ['Alice', 'Charlie']);
  });

  test('nested field eq() - boolean', async () => {
    const results = await repo.find({ where: User.fields.settings.darkMode.eq(true) });
    assert.strictEqual(results.length, 2); // Alice and Charlie
  });

  test('deeply nested field eq()', async () => {
    const results = await repo.find({ where: User.fields.settings.notifications.push.eq(true) });
    assert.strictEqual(results.length, 2); // Alice and Charlie
    const names = results.map((r) => r.name).sort();
    assert.deepStrictEqual(names, ['Alice', 'Charlie']);
  });

  test('nested conditions combined with AND', async () => {
    const results = await repo.find({
      where: q.and(
        User.fields.settings.theme.eq('dark'),
        User.fields.settings.notifications.email.eq(true),
      ),
    });
    assert.strictEqual(results.length, 1); // Only Alice
    assert.strictEqual(results[0].name, 'Alice');
  });

  test('nested conditions combined with OR', async () => {
    const results = await repo.find({
      where: q.or(
        User.fields.settings.notifications.push.eq(true),
        User.fields.settings.notifications.email.eq(true),
      ),
    });
    assert.strictEqual(results.length, 3); // Alice, Bob, Charlie (all except Diana)
  });

  test('nested conditions combined with top-level conditions', async () => {
    const results = await repo.find({
      where: q.and(
        User.fields.active.isTrue(),
        User.fields.settings.theme.eq('dark'),
      ),
    });
    assert.strictEqual(results.length, 1); // Only Alice (Charlie is not active)
    assert.strictEqual(results[0].name, 'Alice');
  });

  test('deeply nested with array conditions', async () => {
    // Add users with tags for this test
    repo.clear();
    await repo.insertMany([
      { email: 'dev@test.com', name: 'Dev', age: 25, balance: '0.00', active: true, role: 'user', tags: ['typescript'], settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: true } } },
      { email: 'qa@test.com', name: 'QA', age: 30, balance: '0.00', active: true, role: 'user', tags: ['testing'], settings: { theme: 'dark', darkMode: false, notifications: { email: true, push: false } } },
    ]);

    const results = await repo.find({
      where: q.and(
        User.fields.settings.notifications.push.eq(true),
        User.fields.tags.contains('typescript'),
      ),
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'Dev');
  });
});

// =============================================================================
// Has() Condition Tests (Relationship Queries)
// =============================================================================

describe('InMemoryRepository - Has Conditions', () => {
  // User repository (no relation resolver needed)
  let userRepo: InMemoryRepository<User>;
  // Post repository (needs relation resolver to look up authors)
  let postRepo: InMemoryRepository<Post>;

  beforeEach(async () => {
    // Create user repository first
    userRepo = new InMemoryRepository();

    // Create users
    const alice = await userRepo.insert({
      email: 'alice@test.com',
      name: 'Alice',
      age: 25,
      balance: '100.00',
      active: true,
      role: 'admin',
      tags: ['dev'],
      settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: true } },
    });
    const bob = await userRepo.insert({
      email: 'bob@test.com',
      name: 'Bob',
      age: 30,
      balance: '200.00',
      active: false,
      role: 'user',
      tags: ['qa'],
      settings: { theme: 'light', darkMode: false, notifications: { email: false, push: false } },
    });

    // Create post repository with relation resolver
    postRepo = new InMemoryRepository({
      fieldDefs: getModelFields(Post),
      relationResolver: (refId, _fieldDef) => {
        // Look up the user by ID
        const user = userRepo['store'].get(refId);
        return user as Record<string, unknown> | undefined;
      },
    });

    // Create posts
    await postRepo.insert({
      title: 'Alice Post 1',
      content: 'Content by Alice',
      views: 100,
      rating: '4.5',
      published: true,
      author: alice,
    } as unknown as Post);
    await postRepo.insert({
      title: 'Alice Post 2',
      content: 'Another by Alice',
      views: 50,
      rating: '3.5',
      published: false,
      author: alice,
    } as unknown as Post);
    await postRepo.insert({
      title: 'Bob Post',
      content: 'Content by Bob',
      views: 200,
      rating: '5.0',
      published: true,
      author: bob,
    } as unknown as Post);
  });

  test('has() finds posts by related user condition', async () => {
    // Find posts where author is active
    const results = await postRepo.find({
      where: Post.fields.author.has(User.fields.active.isTrue()),
    });

    assert.strictEqual(results.length, 2); // Both Alice posts (she's active)
    assert.ok(results.every((p) => (p as unknown as Record<string, unknown>).title?.toString().includes('Alice')));
  });

  test('has() with role condition', async () => {
    // Find posts where author is admin
    const results = await postRepo.find({
      where: Post.fields.author.has(User.fields.role.eq('admin')),
    });

    assert.strictEqual(results.length, 2); // Alice is admin
  });

  test('has() combined with own field condition', async () => {
    // Find published posts where author is active
    const results = await postRepo.find({
      where: q.and(
        Post.fields.published.isTrue(),
        Post.fields.author.has(User.fields.active.isTrue()),
      ),
    });

    assert.strictEqual(results.length, 1); // Only Alice Post 1 (published + active author)
    assert.strictEqual((results[0] as unknown as Record<string, unknown>).title, 'Alice Post 1');
  });

  test('has() returns empty when no match', async () => {
    // Find posts where author has role 'guest' (none)
    const results = await postRepo.find({
      where: Post.fields.author.has(User.fields.role.eq('guest')),
    });

    assert.strictEqual(results.length, 0);
  });

  test('has() with nested object condition on related entity', async () => {
    // Find posts where author has dark theme
    const results = await postRepo.find({
      where: Post.fields.author.has(User.fields.settings.theme.eq('dark')),
    });

    assert.strictEqual(results.length, 2); // Alice's posts (she has dark theme)
  });

  test('has() throws without relation resolver', async () => {
    const repoWithoutResolver = new InMemoryRepository<Post>();
    await repoWithoutResolver.insert({
      title: 'Test',
      content: 'Content',
      views: 0,
      published: false,
      authorId: 'some-id',
    } as unknown as Post);

    await assert.rejects(
      async () => repoWithoutResolver.find({
        where: Post.fields.author.has(User.fields.active.isTrue()),
      }),
      /HAS conditions require a relation resolver/,
    );
  });
});
