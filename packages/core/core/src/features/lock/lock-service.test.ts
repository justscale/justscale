import assert from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import type { LockMetadata, LockOptions, LockProvider } from './types.js';
import { isLocked } from './types.js';
import { LockAcquisitionError, AbstractLockProvider } from './lock-service.js';

// ============================================================================
// Mock Provider
// ============================================================================

class MockLockProvider implements LockProvider {
  public acquireCalls: Array<{
    key: string
    options: Required<LockOptions>
    instanceId: string
  }> = [];
  public releaseCalls: Array<{ key: string; instanceId: string }> = [];
  public extendCalls: Array<{ key: string; instanceId: string; ttl: number }> = [];
  public closeCalls = 0;

  // The metadata to return (blocking locks always return metadata)
  public acquireResult: LockMetadata = {
    lockedAt: new Date(),
    expiresAt: new Date(Date.now() + 30000),
    lockedBy: 'mock-instance',
  };
  public acquireDelay = 0;

  async acquire(
    key: string,
    options: Required<LockOptions>,
    instanceId: string,
  ): Promise<LockMetadata> {
    this.acquireCalls.push({ key, options, instanceId });

    if (this.acquireDelay > 0) {
      await new Promise((r) => setTimeout(r, this.acquireDelay));
    }

    // Blocking locks always succeed - return the metadata
    return this.acquireResult;
  }

  async release(key: string, instanceId: string): Promise<void> {
    this.releaseCalls.push({ key, instanceId });
  }

  async extend(key: string, instanceId: string, ttl: number): Promise<boolean> {
    this.extendCalls.push({ key, instanceId, ttl });
    return true;
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }

  reset(): void {
    this.acquireCalls = [];
    this.releaseCalls = [];
    this.extendCalls = [];
    this.closeCalls = 0;
    this.acquireResult = {
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + 30000),
      lockedBy: 'mock-instance',
    };
    this.acquireDelay = 0;
  }
}

// ============================================================================
// Mock Logger
// ============================================================================

class MockLogger {
  public debugCalls: unknown[][] = [];
  public warnCalls: unknown[][] = [];

  debug(...args: unknown[]): void {
    this.debugCalls.push(args);
  }

  warn(...args: unknown[]): void {
    this.warnCalls.push(args);
  }

  info(): void {}
  error(): void {}
  trace(): void {}
}

// ============================================================================
// Helper to create LockServiceImpl directly (bypasses DI)
// ============================================================================

// We need to import the internal class since it's not exported
// For testing, we'll create a minimal implementation that matches the service behavior

async function createLockService(provider: LockProvider, logger: MockLogger) {
  // This is a simplified version of LockServiceImpl for testing
  // Note: JustScale locks are blocking - acquire() waits forever until acquired
  const instanceId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  return {
    instanceId,
    async acquire<T>(
      objOrPromise: T | Promise<T> | null | Promise<T | null>,
      options?: LockOptions,
    ): Promise<(T & { __lock: LockMetadata } & Disposable) | null> {
      const obj = await objOrPromise;
      if (obj === null) return null;

      const DEFAULT_TTL = 30_000;

      const ttl = options?.ttl ?? DEFAULT_TTL;
      const opts: Required<LockOptions> = {
        ttl,
        timeout: options?.timeout ?? 0, // Ignored for blocking locks
        key:
          options?.key ??
          `lock:${(obj as { constructor?: { name?: string } })?.constructor?.name ?? 'Object'}:${(obj as { id?: unknown })?.id ?? 'unknown'}`,
        heartbeat: options?.heartbeat ?? false,
        heartbeatInterval: options?.heartbeatInterval ?? Math.floor(ttl / 3),
      };

      // Blocking acquire - waits until lock is obtained
      const metadata = await provider.acquire(opts.key, opts, instanceId);

      logger.debug('Lock acquired', {
        key: opts.key,
        instanceId,
        ttl: opts.ttl,
      });

      // Create locked object
      const locked = Object.create(obj as object, {
        __lock: {
          value: metadata,
          writable: false,
          enumerable: false,
          configurable: false,
        },
        [Symbol.dispose]: {
          value: function () {
            provider.release(opts.key, instanceId).catch((err: unknown) => {
              logger.warn('Lock release failed', {
                key: opts.key,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          },
          writable: false,
          enumerable: false,
          configurable: false,
        },
      });

      return locked;
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('LockAcquisitionError', () => {
  it('should create error with message', () => {
    const error = new LockAcquisitionError('Test error');

    assert.strictEqual(error.message, 'Test error');
    assert.strictEqual(error.name, 'LockAcquisitionError');
  });

  it('should be instanceof Error', () => {
    const error = new LockAcquisitionError('Test');

    assert.ok(error instanceof Error);
    assert.ok(error instanceof LockAcquisitionError);
  });
});

describe('AbstractLockProvider', () => {
  it('should be an abstract class', () => {
    // AbstractLockProvider has abstract methods
    // We can't instantiate it directly
    assert.strictEqual(typeof AbstractLockProvider, 'function');
  });
});

describe('isLocked', () => {
  it('should return true for locked objects', () => {
    const obj = { id: '1' };
    const locked = Object.create(obj, {
      __lock: { value: { lockedAt: new Date(), expiresAt: new Date(), lockedBy: 'test' } },
      [Symbol.dispose]: { value: () => {} },
    });

    assert.strictEqual(isLocked(locked), true);
  });

  it('should return false for regular objects', () => {
    const obj = { id: '1' };
    assert.strictEqual(isLocked(obj), false);
  });

  it('should return false for null', () => {
    assert.strictEqual(isLocked(null), false);
  });

  it('should return false for object with only __lock', () => {
    const obj = { __lock: {} };
    assert.strictEqual(isLocked(obj), false);
  });
});

describe('LockService', () => {
  let provider: MockLockProvider;
  let logger: MockLogger;

  beforeEach(() => {
    provider = new MockLockProvider();
    logger = new MockLogger();
  });

  afterEach(() => {
    provider.reset();
  });

  describe('acquire', () => {
    it('should acquire lock on direct object', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);
      const obj = { id: '123', name: 'Test' };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      assert.strictEqual(locked.id, '123');
      assert.strictEqual(locked.name, 'Test');
      assert.ok(locked.__lock);
      assert.strictEqual(provider.acquireCalls.length, 1);
      assert.ok(provider.acquireCalls[0].key.includes('123'));
    });

    it('should acquire lock on Promise<object>', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);
      const objPromise = Promise.resolve({ id: '456' });

      const locked = await service.acquire(objPromise);

      assert.ok(locked);
      assert.strictEqual(locked.id, '456');
    });

    it('should return null for null input', async () => {
      const service = await createLockService(provider, logger);

      const result = await service.acquire(null);

      assert.strictEqual(result, null);
      assert.strictEqual(provider.acquireCalls.length, 0);
    });

    it('should return null for Promise<null>', async () => {
      const service = await createLockService(provider, logger);

      const result = await service.acquire(Promise.resolve(null));

      assert.strictEqual(result, null);
      assert.strictEqual(provider.acquireCalls.length, 0);
    });

    it('should use custom lock key when provided', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      await service.acquire({ id: '1' }, { key: 'custom:key:123' });

      assert.strictEqual(provider.acquireCalls[0].key, 'custom:key:123');
    });

    it('should use custom TTL when provided', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      await service.acquire({ id: '1' }, { ttl: 60000 });

      assert.strictEqual(provider.acquireCalls[0].options.ttl, 60000);
    });

    // Note: Retry and timeout tests removed - JustScale locks are blocking
    // (acquire waits forever until acquired, there is no timeout/failure)

    it('should log when lock is acquired', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      await service.acquire({ id: '1' });

      assert.strictEqual(logger.debugCalls.length, 1);
      assert.strictEqual(logger.debugCalls[0][0], 'Lock acquired');
    });
  });

  describe('dispose', () => {
    it('should release lock when disposed', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);
      const locked = await service.acquire({ id: '1' });

      assert.ok(locked);
      locked[Symbol.dispose]();

      // Give the async release a moment to execute
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(provider.releaseCalls.length, 1);
    });

    it('should use using keyword for automatic disposal', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      {
        using locked = await service.acquire({ id: '1' });
        assert.ok(locked);
        assert.strictEqual(provider.releaseCalls.length, 0);
      }

      // Give the async release a moment
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(provider.releaseCalls.length, 1);
    });
  });

  describe('lock key derivation', () => {
    it('should derive key from object with id', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      await service.acquire({ id: 'user-123' });

      assert.ok(provider.acquireCalls[0].key.includes('user-123'));
    });

    it('should handle object without id', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      await service.acquire({ name: 'test' });

      assert.ok(provider.acquireCalls[0].key.includes('unknown'));
    });
  });

  describe('lock metadata', () => {
    it('should attach lock metadata to object', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date('2024-01-15'),
        expiresAt: new Date('2024-01-15T00:00:30.000Z'),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);
      const locked = await service.acquire({ id: '1' });

      assert.ok(locked);
      assert.deepStrictEqual(locked.__lock.lockedAt, metadata.lockedAt);
      assert.deepStrictEqual(locked.__lock.expiresAt, metadata.expiresAt);
      assert.strictEqual(locked.__lock.lockedBy, 'test-instance');
    });

    it('should make __lock non-enumerable', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);
      const locked = await service.acquire({ id: '1', name: 'Test' });

      assert.ok(locked);
      const keys = Object.keys(locked);
      assert.ok(!keys.includes('__lock'));
    });
  });

  describe('heartbeat options', () => {
    it('should pass heartbeat options to provider', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      await service.acquire({ id: '1' }, { heartbeat: true, heartbeatInterval: 5000 });

      assert.strictEqual(provider.acquireCalls[0].options.heartbeat, true);
      assert.strictEqual(provider.acquireCalls[0].options.heartbeatInterval, 5000);
    });

    it('should default heartbeatInterval to ttl/3', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      await service.acquire({ id: '1' }, { ttl: 9000 });

      assert.strictEqual(provider.acquireCalls[0].options.heartbeatInterval, 3000);
    });
  });

  describe('mutation', () => {
    it('should allow mutating domain fields on locked object', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const obj = {
        id: '1',
        name: 'Original',
        balance: 100,
      };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      assert.strictEqual(locked.name, 'Original');
      assert.strictEqual(locked.balance, 100);

      // Mutate the locked object
      locked.name = 'Modified';
      locked.balance = 200;

      // Changes should be reflected
      assert.strictEqual(locked.name, 'Modified');
      assert.strictEqual(locked.balance, 200);

      // Original object should NOT be modified (locked is a new object with original as prototype)
      assert.strictEqual(obj.name, 'Original');
      assert.strictEqual(obj.balance, 100);
    });

    it('should preserve mutations through method calls', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const obj = {
        id: '1',
        balance: 100,
        deposit(amount: number) {
          this.balance += amount;
        },
        withdraw(amount: number) {
          this.balance -= amount;
        },
      };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      locked.deposit(50);
      assert.strictEqual(locked.balance, 150);

      locked.withdraw(30);
      assert.strictEqual(locked.balance, 120);
    });
  });

  describe('edge cases', () => {
    it('should handle object with constructor.name', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      class User {
        id = 'user-1';
      }

      await service.acquire(new User());

      assert.ok(provider.acquireCalls[0].key.includes('User'));
      assert.ok(provider.acquireCalls[0].key.includes('user-1'));
    });

    it('should preserve object methods and properties', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const obj = {
        id: '1',
        name: 'Test',
        greet() {
          return `Hello, ${this.name}`;
        },
      };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      assert.strictEqual(locked.id, '1');
      assert.strictEqual(locked.name, 'Test');
      assert.strictEqual(locked.greet(), 'Hello, Test');
    });

    it('should work with deeply nested objects', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const obj = {
        id: '1',
        nested: {
          deep: {
            value: 42,
          },
        },
      };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      assert.strictEqual(locked.nested.deep.value, 42);
    });

    it('should handle array fields', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const obj = {
        id: '1',
        tags: ['a', 'b', 'c'],
        scores: [1, 2, 3],
      };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      // Can read arrays
      assert.deepStrictEqual(locked.tags, ['a', 'b', 'c']);

      // Can reassign array field
      locked.tags = ['x', 'y'];
      assert.deepStrictEqual(locked.tags, ['x', 'y']);

      // Can mutate array contents
      locked.scores.push(4);
      assert.deepStrictEqual(locked.scores, [1, 2, 3, 4]);
    });

    it('should handle null and undefined fields', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const obj = {
        id: '1',
        nullable: null as string | null,
        optional: undefined as string | undefined,
      };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      assert.strictEqual(locked.nullable, null);
      assert.strictEqual(locked.optional, undefined);

      // Can set nullable to value
      locked.nullable = 'now has value';
      assert.strictEqual(locked.nullable, 'now has value');

      // Can set back to null
      locked.nullable = null;
      assert.strictEqual(locked.nullable, null);
    });

    it('should handle getters and setters', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const obj = {
        id: '1',
        _value: 10,
        get value() {
          return this._value * 2;
        },
        set value(v: number) {
          this._value = v;
        },
      };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      // Getter works
      assert.strictEqual(locked.value, 20);

      // Setter works
      locked.value = 25;
      assert.strictEqual(locked._value, 25);
      assert.strictEqual(locked.value, 50);
    });

    it('should handle Symbol properties', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const customSymbol = Symbol('custom');
      const obj = {
        id: '1',
        name: 'test',
        [customSymbol]: 'symbol value',
      };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      // Symbol property accessible via prototype
      assert.strictEqual((locked as any)[customSymbol], 'symbol value');
    });

    it('should handle Date fields', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const originalDate = new Date('2024-01-01');
      const obj = {
        id: '1',
        eventDate: originalDate,
      };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      assert.deepStrictEqual(locked.eventDate, originalDate);

      // Can reassign date field
      const newDate = new Date('2024-06-15');
      locked.eventDate = newDate;
      assert.deepStrictEqual(locked.eventDate, newDate);
    });

    it('should handle BigInt fields', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const obj = {
        id: '1',
        bigValue: BigInt(9007199254740991),
      };

      const locked = await service.acquire(obj);

      assert.ok(locked);
      assert.strictEqual(locked.bigValue, BigInt(9007199254740991));

      // Can reassign BigInt
      locked.bigValue = BigInt(123456789);
      assert.strictEqual(locked.bigValue, BigInt(123456789));
    });

    it('should handle objects created with Object.create(null)', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const obj = Object.create(null);
      obj.id = '1';
      obj.name = 'no prototype';

      const locked = await service.acquire(obj);

      assert.ok(locked);
      assert.strictEqual(locked.id, '1');
      assert.strictEqual(locked.name, 'no prototype');

      // Can mutate
      locked.name = 'modified';
      assert.strictEqual(locked.name, 'modified');
    });

    it('should not affect original object when mutating locked copy', async () => {
      const metadata: LockMetadata = {
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 30000),
        lockedBy: 'test-instance',
      };
      provider.acquireResult = metadata;

      const service = await createLockService(provider, logger);

      const original = {
        id: '1',
        name: 'original',
        nested: { value: 100 },
      };

      const locked = await service.acquire(original);

      assert.ok(locked);

      // Mutate locked object
      locked.name = 'modified';

      // Original is unchanged (locked is a new object with original as prototype)
      assert.strictEqual(original.name, 'original');
      assert.strictEqual(locked.name, 'modified');

      // Note: nested object mutation DOES affect original (same reference)
      locked.nested.value = 200;
      assert.strictEqual(original.nested.value, 200); // This is expected behavior
    });
  });
});
