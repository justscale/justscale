/**
 * Tests for repository lock() method and Locked<T> enforcement.
 *
 * Covers:
 * - lock() with Persistent entities, References, Promises, null/undefined
 * - Re-read freshness guarantee
 * - Lock metadata and disposal
 * - Locked entity usability with update/save/delete
 * - Edge cases: non-existent entity, disposed lock
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  defineModel,
  field,
  createInMemoryModel,
  isLocked,
} from '../../src/models/index.js';
import { ADAPTER_KEY } from '../../src/models/symbols.js';
import { MEM_VERSION } from '../../src/models/in-memory/in-memory-repository.js';
import { Reference } from '../../src/models/reference/reference.js';

// =============================================================================
// Test Models
// =============================================================================

class Account extends defineModel({
  email: field.string(),
  name: field.string(),
  balance: field.decimal(10, 2),
}) {}

// =============================================================================
// lock() Behavior
// =============================================================================

describe('lock()', () => {
  let repo: any;

  beforeEach(() => {
    repo = createInMemoryModel(Account).repository();
  });

  test('locks a Persistent entity and returns Locked<T>', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Alice', balance: '100.00' });
    const locked = await repo.lock(account);

    assert.ok(locked, 'lock should return non-null');
    assert.ok(isLocked(locked), 'should be detected as locked by isLocked()');
    assert.strictEqual((locked as any).email, 'a@b.com');
    assert.strictEqual((locked as any).name, 'Alice');
  });

  test('locks a Reference by extracting identifier', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Alice', balance: '100.00' });
    const id = (account as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string;
    const ref = Account.ref(id);

    const locked = await repo.lock(ref);

    assert.ok(locked, 'lock via Reference should return non-null');
    assert.strictEqual(locked!.email, 'a@b.com');
  });

  test('locks a Promise<Persistent<T>>', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Alice', balance: '100.00' });
    const id = (account as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string;

    // Pass a Promise directly (like params.ticket in a controller)
    const locked = await repo.lock(repo.get(Account.ref(id)));

    assert.ok(locked, 'lock via Promise should return non-null');
    assert.strictEqual(locked!.name, 'Alice');
  });

  test('returns null for non-existent entity', async () => {
    const ref = Account.ref('non-existent-id');
    const locked = await repo.lock(ref);

    assert.strictEqual(locked, null);
  });

  test('returns null for Promise resolving to null', async () => {
    const locked = await repo.lock(Promise.resolve(null));

    assert.strictEqual(locked, null);
  });

  test('returns null for Promise resolving to undefined', async () => {
    const locked = await repo.lock(Promise.resolve(undefined));

    assert.strictEqual(locked, null);
  });

  test('re-reads from store — returns fresh data', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Original', balance: '100.00' });

    // Mutate via the first lock, releasing it before the second acquire.
    {
      await using locked1 = await repo.lock(account);
      await repo.update(locked1!, { name: 'Updated' });
    }

    // Lock the original entity — should get fresh "Updated" data.
    await using locked2 = await repo.lock(account);
    assert.ok(locked2);
    assert.strictEqual(locked2!.name, 'Updated', 'lock should re-read fresh data from store');
  });

  test('lock has proper metadata', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Alice', balance: '100.00' });
    await using locked = await repo.lock(account, { ttl: 5000 });

    assert.ok(locked);
    const meta = (locked as any).__lock;
    assert.ok(meta, 'should have __lock metadata');
    assert.ok(meta.lockedAt instanceof Date, 'lockedAt should be a Date');
    assert.ok(meta.expiresAt instanceof Date, 'expiresAt should be a Date');
    // lockedBy is now the per-repo instanceId (a UUID) — used to disambiguate
    // multiple repos sharing a LockProvider. Just assert it's a non-empty string.
    assert.ok(typeof meta.lockedBy === 'string' && meta.lockedBy.length > 0);
    // TTL: expiresAt should be ~5s after lockedAt
    const diff = meta.expiresAt.getTime() - meta.lockedAt.getTime();
    assert.ok(diff >= 4900 && diff <= 5100, `TTL should be ~5000ms, got ${diff}ms`);
  });

  test('locked entity is Disposable', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Alice', balance: '100.00' });
    const locked = await repo.lock(account);

    assert.ok(locked);
    assert.strictEqual(typeof locked![Symbol.dispose], 'function');

    // Dispose should not throw
    locked![Symbol.dispose]();
  });

  test('using pattern works without error', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Alice', balance: '100.00' });

    // Verify that `using` with a lock doesn't throw
    {
      using locked = await repo.lock(account);
      assert.ok(locked);
      assert.strictEqual(locked!.name, 'Alice');
    }
    // Block exited — dispose was called (no-op for inmemory). No error = pass.

    // Also verify using with null works
    {
      using locked = await repo.lock(Account.ref('non-existent'));
      assert.strictEqual(locked, null);
    }
  });

  test('using with null does not throw', async () => {
    // This verifies the using + null pattern we discussed
    using locked = await repo.lock(Account.ref('non-existent'));
    assert.strictEqual(locked, null);
    // Block exits — no error because using with null is fine
  });
});

// =============================================================================
// Locked<T> with mutations
// =============================================================================

describe('mutations require Locked<T>', () => {
  let repo: any;

  beforeEach(() => {
    repo = createInMemoryModel(Account).repository();
  });

  test('update() with locked entity modifies and increments version', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Alice', balance: '100.00' });
    using locked = await repo.lock(account);
    assert.ok(locked);

    const updated = await repo.update(locked!, { balance: '200.00' });
    assert.strictEqual(updated.balance, '200.00');
    assert.strictEqual(updated.name, 'Alice'); // unchanged
    assert.strictEqual((updated as unknown as Record<symbol, unknown>)[MEM_VERSION], 2);
  });

  test('sequential lock→update→lock→update increments version correctly', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'V1', balance: '100.00' });

    let v2: typeof account;
    {
      await using locked1 = await repo.lock(account);
      v2 = await repo.update(locked1!, { name: 'V2' });
      assert.strictEqual((v2 as unknown as Record<symbol, unknown>)[MEM_VERSION], 2);
    }

    await using locked2 = await repo.lock(v2);
    const v3 = await repo.update(locked2!, { name: 'V3' });
    assert.strictEqual((v3 as unknown as Record<symbol, unknown>)[MEM_VERSION], 3);
    assert.strictEqual(v3.name, 'V3');
  });

  test('save(locked) updates existing entity', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Alice', balance: '100.00' });
    const id = (account as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string;

    using locked = await repo.lock(account);
    assert.ok(locked);

    // Modify the locked entity's data (Lock makes it mutable)
    (locked as any).name = 'Bob';
    const saved = await repo.save(locked!);

    assert.strictEqual(saved.name, 'Bob');
    assert.strictEqual((saved as unknown as Record<symbol, unknown>)[ADAPTER_KEY], id);
    assert.strictEqual((saved as unknown as Record<symbol, unknown>)[MEM_VERSION], 2);
  });

  test('save(new) inserts without lock', async () => {
    const inserted = await repo.save({ email: 'new@b.com', name: 'New', balance: '0.00' } as any);
    assert.ok(inserted);
    assert.strictEqual(inserted.email, 'new@b.com');
    assert.strictEqual((inserted as unknown as Record<symbol, unknown>)[MEM_VERSION], 1);
  });

  test('delete(locked) removes entity from store', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Alice', balance: '100.00' });
    const id = (account as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string;

    using locked = await repo.lock(account);
    assert.ok(locked);
    const deleted = await repo.delete(locked!);
    assert.strictEqual(deleted, true);

    // Verify gone
    const found = await repo.get(Account.ref(id));
    assert.strictEqual(found, undefined);
  });

  test('delete returns false for entity removed between lock and delete', async () => {
    const account = await repo.insert({ email: 'a@b.com', name: 'Alice', balance: '100.00' });
    const id = (account as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string;

    using locked = await repo.lock(account);
    assert.ok(locked);

    // Remove directly from store (simulating concurrent deletion)
    (repo as any).store.delete(id);

    const deleted = await repo.delete(locked!);
    assert.strictEqual(deleted, false);
  });
});

// =============================================================================
// lock() with model prototype chain
// =============================================================================

describe('lock() preserves model prototype', () => {
  class Product extends defineModel({
    name: field.string(),
    price: field.decimal(10, 2),
  }) {
    get displayPrice() {
      return `$${this.price}`;
    }
  }

  test('locked entity retains model methods via prototype chain', async () => {
    const repo = createInMemoryModel(Product).repository();

    const product = await repo.insert({ name: 'Widget', price: '9.99' });
    assert.strictEqual((product as any).displayPrice, '$9.99');

    using locked = await repo.lock(product);
    assert.ok(locked);
    // Lock wraps via Object.create — methods available through prototype chain
    assert.strictEqual((locked as any).displayPrice, '$9.99');
  });
});

// =============================================================================
// Double-lock detection
// =============================================================================

describe('double-lock detection', () => {
  // Double-lock detection requires the real LockService (not InMemoryRepository's
  // simple wrapper). These tests use the LockServiceImpl via runWithLockTracking.

  test('runWithLockTracking enables tracking in async context', async () => {
    const { runWithLockTracking, getHeldLocks } = await import('../../src/features/lock/lock-service.js');

    await runWithLockTracking(async () => {
      const held = getHeldLocks();
      assert.ok(held, 'should have a held locks set');
      assert.strictEqual(held!.size, 0, 'should start empty');
    });
  });

  test('getHeldLocks returns undefined outside tracking context', async () => {
    const { getHeldLocks } = await import('../../src/features/lock/lock-service.js');
    assert.strictEqual(getHeldLocks(), undefined);
  });

  test('DoubleLockError has the lock key', async () => {
    const { DoubleLockError } = await import('../../src/features/lock/lock-service.js');
    const err = new DoubleLockError('lock:Order:abc');
    assert.strictEqual(err.lockKey, 'lock:Order:abc');
    assert.strictEqual(err.name, 'DoubleLockError');
    assert.ok(err.message.includes('lock:Order:abc'));
  });
});
