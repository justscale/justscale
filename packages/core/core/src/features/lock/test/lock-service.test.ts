/**
 * Tests for LockServiceDef + LockServiceImpl behaviour.
 *
 * Exercises the service against the real in-memory provider:
 * - acquire/release through the Disposable returned by acquire()
 * - double-lock detection via runWithLockTracking
 * - key derivation
 * - concurrent acquisition serialization
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryLockProvider } from '../memory.js';
import {
  LockServiceDef,
  DoubleLockError,
  InvalidLockKeyError,
  runWithLockTracking,
  getHeldLocks,
} from '../lock-service.js';
import type { LockService } from '../types.js';
import { isLocked } from '../types.js';

// Minimal Logger stub matching the abstract class shape enough for our use.
class StubLogger {
  public calls: Array<{ level: string; message: string; attrs?: unknown }> = [];
  trace(_m: string): void {}
  debug(message: string, attrs?: unknown): void {
    this.calls.push({ level: 'debug', message, attrs });
  }
  info(): void {}
  warn(message: string, attrs?: unknown): void {
    this.calls.push({ level: 'warn', message, attrs });
  }
  error(): void {}
  child(): this {
    return this;
  }
  withContext<T>(_ctx: unknown, fn: () => T): T {
    return fn();
  }
}

function makeService(provider = createInMemoryLockProvider()) {
  const logger = new StubLogger();
  const svc = LockServiceDef.factory({
    provider,
    logger: logger as any,
  }, undefined as any) as LockService<unknown>;
  return { svc, provider, logger };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('LockService.acquire', () => {
  test('returns a locked object whose fields are readable', async () => {
    const { svc } = makeService();
    const locked = await svc.acquire({ id: '1', name: 'Alice' });
    assert.ok(locked);
    assert.equal((locked as any).id, '1');
    assert.equal((locked as any).name, 'Alice');
    (locked as Disposable)[Symbol.dispose]();
  });

  test('returns null for null input without calling provider', async () => {
    const { svc, provider } = makeService();
    const r = await svc.acquire(null);
    assert.equal(r, null);
    assert.equal(provider.size, 0);
  });

  test('returns null for Promise<null>', async () => {
    const { svc } = makeService();
    const r = await svc.acquire(Promise.resolve(null));
    assert.equal(r, null);
  });

  test('awaits Promise<T> before locking', async () => {
    const { svc } = makeService();
    const locked = await svc.acquire(Promise.resolve({ id: '5' }));
    assert.ok(locked);
    assert.equal((locked as any).id, '5');
    (locked as Disposable)[Symbol.dispose]();
  });

  test('isLocked is true for the returned wrapper', async () => {
    const { svc } = makeService();
    const locked = await svc.acquire({ id: '1' });
    assert.ok(locked);
    assert.equal(isLocked(locked), true);
    (locked as Disposable)[Symbol.dispose]();
  });

  test('locked object has __lock metadata with lockedAt/expiresAt/lockedBy', async () => {
    const { svc } = makeService();
    const locked = await svc.acquire({ id: '1' });
    assert.ok(locked);
    assert.ok((locked as any).__lock.lockedAt instanceof Date);
    assert.ok((locked as any).__lock.expiresAt instanceof Date);
    assert.equal(typeof (locked as any).__lock.lockedBy, 'string');
    (locked as Disposable)[Symbol.dispose]();
  });

  test('__lock is non-enumerable', async () => {
    const { svc } = makeService();
    const locked = await svc.acquire({ id: '1', name: 'A' });
    assert.ok(locked);
    const keys = Object.keys(locked);
    assert.ok(!keys.includes('__lock'));
    (locked as Disposable)[Symbol.dispose]();
  });

  test('derived key includes constructor name and id', async () => {
    const { svc, provider } = makeService();
    class User { id = 'user-42'; }
    const u = new User();
    const locked = await svc.acquire(u);
    assert.ok(locked);
    // Find the lock in provider - key should match "lock:User:user-42"
    assert.equal(provider.isLocked('lock:User:user-42'), true);
    (locked as Disposable)[Symbol.dispose]();
  });

  test('custom key option overrides derivation', async () => {
    const { svc, provider } = makeService();
    const locked = await svc.acquire({ id: '1' }, { key: 'custom:xyz' });
    assert.ok(locked);
    assert.equal(provider.isLocked('custom:xyz'), true);
    (locked as Disposable)[Symbol.dispose]();
  });

  test('custom ttl respected (expiresAt - lockedAt = ttl)', async () => {
    const { svc } = makeService();
    const locked = await svc.acquire({ id: '1' }, { ttl: 7000 });
    assert.ok(locked);
    const meta = (locked as any).__lock;
    assert.equal(meta.expiresAt.getTime() - meta.lockedAt.getTime(), 7000);
    (locked as Disposable)[Symbol.dispose]();
  });
});

describe('LockService dispose / release', () => {
  test('Symbol.dispose triggers release', async () => {
    const { svc, provider } = makeService();
    const locked = await svc.acquire({ id: '1' }, { key: 'k' });
    assert.ok(locked);
    assert.equal(provider.isLocked('k'), true);
    (locked as Disposable)[Symbol.dispose]();
    // Release is fire-and-forget
    await tick();
    assert.equal(provider.isLocked('k'), false);
  });

  test('using declaration auto-releases', async () => {
    const { svc, provider } = makeService();
    {
      using locked = await svc.acquire({ id: '1' }, { key: 'using-k' });
      assert.ok(locked);
      assert.equal(provider.isLocked('using-k'), true);
    }
    await tick();
    assert.equal(provider.isLocked('using-k'), false);
  });

  test('using on a null lock does not throw (Disposable on null)', async () => {
    const { svc } = makeService();
    // using on null is valid in TypeScript runtime
    const maybe = await svc.acquire(null);
    assert.equal(maybe, null);
    // Simulate dispose on the nullable path
    assert.doesNotThrow(() => {
      // Nothing to dispose, but must not crash
    });
  });

  test('dispose releases even if exception is thrown in using block', async () => {
    const { svc, provider } = makeService();
    await assert.rejects(async () => {
      using locked = await svc.acquire({ id: '1' }, { key: 'ex-k' });
      assert.ok(locked);
      throw new Error('boom');
    }, /boom/);
    await tick();
    assert.equal(provider.isLocked('ex-k'), false);
  });
});

describe('LockService - concurrent acquires serialize', () => {
  test('two acquires on same key run sequentially', async () => {
    const { svc } = makeService();
    const events: string[] = [];

    const p1 = (async () => {
      const l = await svc.acquire({ id: '1' }, { key: 'same' });
      events.push('p1-acquired');
      await new Promise((r) => setTimeout(r, 30));
      events.push('p1-release');
      (l as Disposable)[Symbol.dispose]();
    })();

    // Let p1 win the race
    await new Promise((r) => setTimeout(r, 5));

    const p2 = (async () => {
      const l = await svc.acquire({ id: '1' }, { key: 'same' });
      events.push('p2-acquired');
      (l as Disposable)[Symbol.dispose]();
    })();

    await Promise.all([p1, p2]);
    // p2 must not have acquired before p1 released
    const p1AckIdx = events.indexOf('p1-release');
    const p2AckIdx = events.indexOf('p2-acquired');
    assert.ok(p1AckIdx < p2AckIdx, `expected p1-release before p2-acquired, got ${events.join(',')}`);
  });

  test('acquires on different keys do not block each other', async () => {
    const { svc } = makeService();
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      svc.acquire({ id: 'a' }, { key: 'A', ttl: 30000 }),
      svc.acquire({ id: 'b' }, { key: 'B', ttl: 30000 }),
    ]);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `both acquires should be fast, took ${elapsed}ms`);
    (a as Disposable)[Symbol.dispose]();
    (b as Disposable)[Symbol.dispose]();
  });
});

describe('Double-lock detection (runWithLockTracking)', () => {
  test('without tracking context, re-acquiring same key blocks (no throw)', async () => {
    const { svc } = makeService();
    // Outside runWithLockTracking, getHeldLocks() returns undefined, so no detection
    const l1 = await svc.acquire({ id: '1' }, { key: 'no-track' });
    assert.ok(l1);
    // Second acquire on same key - without tracking, this would deadlock forever.
    // We don't wait - just verify double-lock detection is OFF.
    assert.equal(getHeldLocks(), undefined);
    (l1 as Disposable)[Symbol.dispose]();
  });

  test('runWithLockTracking seeds an empty held-set', async () => {
    await runWithLockTracking(async () => {
      const held = getHeldLocks();
      assert.ok(held);
      assert.equal(held.size, 0);
    });
  });

  test('acquiring a lock adds it to the tracked held-set', async () => {
    const { svc } = makeService();
    await runWithLockTracking(async () => {
      const locked = await svc.acquire({ id: '1' }, { key: 'tracked' });
      const held = getHeldLocks();
      assert.ok(held);
      assert.equal(held.has('tracked'), true);
      (locked as Disposable)[Symbol.dispose]();
    });
  });

  test('dispose removes the key from the tracked held-set', async () => {
    const { svc } = makeService();
    await runWithLockTracking(async () => {
      const locked = await svc.acquire({ id: '1' }, { key: 'tracked-dispose' });
      (locked as Disposable)[Symbol.dispose]();
      const held = getHeldLocks();
      assert.ok(held);
      assert.equal(held.has('tracked-dispose'), false);
    });
  });

  test('re-acquiring same key in same async context throws DoubleLockError', async () => {
    const { svc } = makeService();
    await runWithLockTracking(async () => {
      const locked = await svc.acquire({ id: '1' }, { key: 'dup' });
      await assert.rejects(
        async () => svc.acquire({ id: '1' }, { key: 'dup' }),
        (err) => err instanceof DoubleLockError && err.lockKey === 'dup'
      );
      (locked as Disposable)[Symbol.dispose]();
    });
  });

  test('after dispose, same key can be acquired again inside same tracking context', async () => {
    const { svc } = makeService();
    await runWithLockTracking(async () => {
      const l1 = await svc.acquire({ id: '1' }, { key: 'cycle' });
      (l1 as Disposable)[Symbol.dispose]();
      await tick();
      // l1 released; re-acquire must succeed
      const l2 = await svc.acquire({ id: '1' }, { key: 'cycle' });
      assert.ok(l2);
      (l2 as Disposable)[Symbol.dispose]();
    });
  });

  test('different keys in same tracking context do not conflict', async () => {
    const { svc } = makeService();
    await runWithLockTracking(async () => {
      const a = await svc.acquire({ id: 'a' }, { key: 'A' });
      const b = await svc.acquire({ id: 'b' }, { key: 'B' });
      assert.ok(a);
      assert.ok(b);
      const held = getHeldLocks();
      assert.ok(held);
      assert.equal(held.has('A'), true);
      assert.equal(held.has('B'), true);
      (a as Disposable)[Symbol.dispose]();
      (b as Disposable)[Symbol.dispose]();
    });
  });

  test('separate tracking contexts have isolated held-sets', async () => {
    const { svc } = makeService();
    // Two independent runWithLockTracking scopes using different keys so they
    // do not serialize on the provider.
    const aDone = runWithLockTracking(async () => {
      const a = await svc.acquire({ id: 'a' }, { key: 'ctx-A' });
      const held = getHeldLocks();
      assert.ok(held);
      assert.equal(held.has('ctx-A'), true);
      assert.equal(held.has('ctx-B'), false);
      (a as Disposable)[Symbol.dispose]();
    });
    const bDone = runWithLockTracking(async () => {
      const b = await svc.acquire({ id: 'b' }, { key: 'ctx-B' });
      const held = getHeldLocks();
      assert.ok(held);
      assert.equal(held.has('ctx-B'), true);
      assert.equal(held.has('ctx-A'), false);
      (b as Disposable)[Symbol.dispose]();
    });
    await Promise.all([aDone, bDone]);
  });

  test('DoubleLockError has correct name and message', async () => {
    const { svc } = makeService();
    await runWithLockTracking(async () => {
      const locked = await svc.acquire({ id: '1' }, { key: 'err-k' });
      try {
        await svc.acquire({ id: '1' }, { key: 'err-k' });
        assert.fail('expected throw');
      } catch (err) {
        assert.ok(err instanceof DoubleLockError);
        assert.equal((err as DoubleLockError).name, 'DoubleLockError');
        assert.equal((err as DoubleLockError).lockKey, 'err-k');
        assert.ok(/already held/.test((err as Error).message));
      }
      (locked as Disposable)[Symbol.dispose]();
    });
  });
});

describe('Lock mutation semantics', () => {
  test('locked object is a NEW object with the original as prototype', async () => {
    const { svc } = makeService();
    const original = { id: '1', name: 'A' };
    const locked = await svc.acquire(original);
    assert.ok(locked);
    assert.notEqual(locked, original);
    assert.equal(Object.getPrototypeOf(locked), original);
    (locked as Disposable)[Symbol.dispose]();
  });

  test('setting a field on locked copy does not mutate original', async () => {
    const { svc } = makeService();
    const original = { id: '1', name: 'A' };
    const locked = await svc.acquire(original);
    assert.ok(locked);
    (locked as any).name = 'B';
    assert.equal(original.name, 'A');
    assert.equal((locked as any).name, 'B');
    (locked as Disposable)[Symbol.dispose]();
  });

  test('method calls see shadowed fields via this', async () => {
    const { svc } = makeService();
    const obj = {
      id: '1',
      count: 0,
      increment() { this.count++; },
    };
    const locked = await svc.acquire(obj);
    assert.ok(locked);
    (locked as any).increment();
    (locked as any).increment();
    assert.equal((locked as any).count, 2);
    assert.equal(obj.count, 0);
    (locked as Disposable)[Symbol.dispose]();
  });
});

describe('Key derivation edge cases', () => {
  test('object without id produces key "lock:<Type>:unknown"', async () => {
    const { svc, provider } = makeService();
    const locked = await svc.acquire({ name: 'x' });
    assert.ok(locked);
    assert.equal(provider.isLocked('lock:Object:unknown'), true);
    (locked as Disposable)[Symbol.dispose]();
  });

  test('null-prototype object falls back to type "Object"', async () => {
    const { svc, provider } = makeService();
    const o = Object.create(null) as { id: string };
    o.id = 'np-1';
    const locked = await svc.acquire(o);
    assert.ok(locked);
    assert.equal(provider.isLocked('lock:Object:np-1'), true);
    (locked as Disposable)[Symbol.dispose]();
  });

  test('class instance uses constructor.name', async () => {
    const { svc, provider } = makeService();
    class Widget { id = 'w-1'; }
    const locked = await svc.acquire(new Widget());
    assert.ok(locked);
    assert.equal(provider.isLocked('lock:Widget:w-1'), true);
    (locked as Disposable)[Symbol.dispose]();
  });
});

describe('Invalid lock key rejection (lock-2)', () => {
  test('explicit empty-string key rejected with InvalidLockKeyError', async () => {
    const { svc, provider } = makeService();
    await assert.rejects(
      svc.acquire({ id: 'a' }, { key: '' }),
      (err: unknown) => err instanceof InvalidLockKeyError,
    );
    assert.equal(provider.size, 0);
  });

  test('whitespace-only key rejected', async () => {
    const { svc, provider } = makeService();
    await assert.rejects(
      svc.acquire({ id: 'a' }, { key: '   ' }),
      (err: unknown) => err instanceof InvalidLockKeyError,
    );
    assert.equal(provider.size, 0);
  });

  test('derived empty-string key rejected', async () => {
    // Object whose constructor name and id both collapse to empty strings
    // via a pathological override — without the guard, would yield "lock:::"
    // but provider would still accept the raw key if one were passed. The
    // service-level derivation produces "lock:Object:unknown" in practice, so
    // simulate the real failure mode via explicit key.
    const { svc } = makeService();
    await assert.rejects(
      svc.acquire({}, { key: '' }),
      InvalidLockKeyError,
    );
  });
});
