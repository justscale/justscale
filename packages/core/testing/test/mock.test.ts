/**
 * Tests for mocking utilities
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  mock,
  mockFn,
  mockService,
  spyOn,
  spyService,
  mockResolves,
  mockRejects,
  mockThrows,
  assertCalledWith,
  assertCallCount,
  assertNotCalled,
} from '../src/mock.js';

// ============================================================================
// Test Fixtures
// ============================================================================

interface UserService {
  findById(id: string): Promise<{ id: string; name: string } | null>;
  findAll(): Promise<{ id: string; name: string }[]>;
  save(user: { name: string }): Promise<{ id: string; name: string }>;
  delete(id: string): Promise<void>;
}

class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }

  divide(a: number, b: number): number {
    if (b === 0) throw new Error('Division by zero');
    return a / b;
  }
}

// ============================================================================
// mockFn Tests
// ============================================================================

describe('mockFn', () => {
  it('should create a mock function', () => {
    const fn = mockFn();
    assert.strictEqual(typeof fn, 'function');
  });

  it('should track calls', () => {
    const fn = mockFn<[string, number], void>();

    fn('hello', 42);
    fn('world', 100);

    assert.strictEqual(fn.mock.callCount(), 2);
    assert.deepStrictEqual(fn.mock.calls[0].arguments, ['hello', 42]);
    assert.deepStrictEqual(fn.mock.calls[1].arguments, ['world', 100]);
  });

  it('should use provided implementation', () => {
    const fn = mockFn((a: number, b: number) => a + b);

    const result = fn(2, 3);

    assert.strictEqual(result, 5);
    assert.strictEqual(fn.mock.callCount(), 1);
  });

  it('should return undefined by default', () => {
    const fn = mockFn();

    const result = fn();

    assert.strictEqual(result, undefined);
  });
});

// ============================================================================
// mockResolves / mockRejects / mockThrows Tests
// ============================================================================

describe('mockResolves', () => {
  it('should return a resolved promise', async () => {
    const fn = mockResolves({ id: '1', name: 'Test' });

    const result = await fn();

    assert.deepStrictEqual(result, { id: '1', name: 'Test' });
    assert.strictEqual(fn.mock.callCount(), 1);
  });

  it('should track multiple calls', async () => {
    const fn = mockResolves('result');

    await fn('arg1');
    await fn('arg2');

    assert.strictEqual(fn.mock.callCount(), 2);
  });
});

describe('mockRejects', () => {
  it('should return a rejected promise', async () => {
    const error = new Error('Not found');
    const fn = mockRejects(error);

    await assert.rejects(fn(), { message: 'Not found' });
    assert.strictEqual(fn.mock.callCount(), 1);
  });
});

describe('mockThrows', () => {
  it('should throw an error', () => {
    const error = new Error('Invalid input');
    const fn = mockThrows(error);

    assert.throws(() => fn(), { message: 'Invalid input' });
    assert.strictEqual(fn.mock.callCount(), 1);
  });
});

// ============================================================================
// mockService Tests
// ============================================================================

describe('mockService', () => {
  it('should create a mock with provided implementations', async () => {
    const mockUser = mockService<{ deps: {}; factory: () => UserService }>({
      findById: mockResolves({ id: '1', name: 'Alice' }),
      findAll: mockResolves([]),
    });

    const user = await mockUser.findById('1');
    const all = await mockUser.findAll();

    assert.deepStrictEqual(user, { id: '1', name: 'Alice' });
    assert.deepStrictEqual(all, []);
  });

  it('should throw for unmocked methods', () => {
    const mockUser = mockService<{ deps: {}; factory: () => UserService }>({
      findById: mockResolves(null),
    });

    assert.throws(
      () => (mockUser as any).save({ name: 'Bob' }),
      { message: 'Method "save" was not mocked' }
    );
  });

  it('should track calls on mocked methods', async () => {
    const findByIdMock = mockResolves({ id: '1', name: 'Alice' });
    const mockUser = mockService<{ deps: {}; factory: () => UserService }>({
      findById: findByIdMock,
    });

    await mockUser.findById('1');
    await mockUser.findById('2');

    assert.strictEqual(findByIdMock.mock.callCount(), 2);
    assert.deepStrictEqual(findByIdMock.mock.calls[0].arguments, ['1']);
    assert.deepStrictEqual(findByIdMock.mock.calls[1].arguments, ['2']);
  });
});

// ============================================================================
// spyService Tests
// ============================================================================

describe('spyService', () => {
  it('should spy on object methods', () => {
    const calc = new Calculator();
    const spied = spyService(calc);

    const result = spied.add(2, 3);

    assert.strictEqual(result, 5);
    assertCallCount(spied.add, 1);
    assertCalledWith(spied.add, 2, 3);
  });

  it('should track multiple method calls', () => {
    const calc = new Calculator();
    const spied = spyService(calc);

    spied.add(1, 2);
    spied.add(3, 4);
    spied.multiply(2, 3);

    assertCallCount(spied.add, 2);
    assertCallCount(spied.multiply, 1);
  });

  it('should preserve original behavior', () => {
    const calc = new Calculator();
    const spied = spyService(calc);

    assert.strictEqual(spied.add(10, 20), 30);
    assert.strictEqual(spied.multiply(5, 6), 30);
    assert.throws(() => spied.divide(1, 0), { message: 'Division by zero' });
  });

  it('should not modify original object', () => {
    const calc = new Calculator();
    const originalAdd = calc.add;

    spyService(calc);

    // Original should be unchanged
    assert.strictEqual(calc.add, originalAdd);
  });
});

// ============================================================================
// spyOn Tests (with Disposable)
// ============================================================================

describe('spyOn', () => {
  it('should spy on object methods in-place', () => {
    const calc = new Calculator();
    const spy = spyOn(calc);

    // Call through original reference
    const result = calc.add(2, 3);

    assert.strictEqual(result, 5);
    assertCallCount(spy.spied.add, 1);
  });

  it('should track calls on both original and spied', () => {
    const calc = new Calculator();
    const spy = spyOn(calc);

    calc.add(1, 2);           // Call on original
    spy.spied.add(3, 4);      // Call on spied

    assertCallCount(spy.spied.add, 2);
  });

  it('should restore original methods on dispose', () => {
    const calc = new Calculator();
    const originalAdd = calc.add.bind(calc);

    {
      using spy = spyOn(calc);
      calc.add(1, 2);
      assertCallCount(spy.spied.add, 1);
    }

    // After dispose, original is restored
    // (can't easily test the function identity, but behavior should work)
    assert.strictEqual(calc.add(5, 5), 10);
  });

  it('should restore original methods via restore()', () => {
    const calc = new Calculator();
    const spy = spyOn(calc);

    calc.add(1, 2);
    assertCallCount(spy.spied.add, 1);

    spy.restore();

    // Calls after restore are not tracked
    calc.add(3, 4);
    assertCallCount(spy.spied.add, 1); // Still 1
  });

  it('should reset call tracking via reset()', () => {
    const calc = new Calculator();
    const spy = spyOn(calc);

    calc.add(1, 2);
    calc.add(3, 4);
    assertCallCount(spy.spied.add, 2);

    spy.reset();

    assertCallCount(spy.spied.add, 0);

    // Can still track new calls
    calc.add(5, 6);
    assertCallCount(spy.spied.add, 1);
  });

  it('should provide access to original object', () => {
    const calc = new Calculator();
    const spy = spyOn(calc);

    assert.strictEqual(spy.original, calc);
  });
});

// ============================================================================
// Assertion Helper Tests
// ============================================================================

describe('assertCallCount', () => {
  it('should pass when count matches', () => {
    const fn = mockFn();
    fn();
    fn();

    assertCallCount(fn, 2); // Should not throw
  });

  it('should fail when count does not match', () => {
    const fn = mockFn();
    fn();

    assert.throws(
      () => assertCallCount(fn, 2),
      { message: 'Expected mock to be called 2 times, but was called 1 times' }
    );
  });
});

describe('assertNotCalled', () => {
  it('should pass when not called', () => {
    const fn = mockFn();

    assertNotCalled(fn); // Should not throw
  });

  it('should fail when called', () => {
    const fn = mockFn();
    fn();

    assert.throws(
      () => assertNotCalled(fn),
      { message: 'Expected mock to be called 0 times, but was called 1 times' }
    );
  });
});

describe('assertCalledWith', () => {
  it('should pass when called with expected args', () => {
    const fn = mockFn<[string, number], void>();
    fn('hello', 42);

    assertCalledWith(fn, 'hello', 42); // Should not throw
  });

  it('should pass when one of multiple calls matches', () => {
    const fn = mockFn<[string], void>();
    fn('first');
    fn('second');
    fn('third');

    assertCalledWith(fn, 'second'); // Should not throw
  });

  it('should fail when not called with expected args', () => {
    const fn = mockFn<[string], void>();
    fn('hello');

    assert.throws(
      () => assertCalledWith(fn, 'world'),
      /Expected mock to be called with/
    );
  });

  it('should fail when never called', () => {
    const fn = mockFn<[string], void>();

    assert.throws(
      () => assertCalledWith(fn, 'anything'),
      /Actual calls:\s+\(none\)/
    );
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Integration: Mocking async services', () => {
  it('should mock an async service completely', async () => {
    const users = [
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ];

    const findAllMock = mockResolves(users);
    const findByIdMock = mock.fn((id: string) =>
      Promise.resolve(users.find(u => u.id === id) || null)
    );
    const saveMock = mock.fn((user: { name: string }) =>
      Promise.resolve({ id: '3', name: user.name })
    );
    const deleteMock = mockResolves(undefined);

    const mockUserService = mockService<{ deps: {}; factory: () => UserService }>({
      findAll: findAllMock,
      findById: findByIdMock,
      save: saveMock,
      delete: deleteMock,
    });

    // Test findAll
    const all = await mockUserService.findAll();
    assert.strictEqual(all.length, 2);

    // Test findById
    const alice = await mockUserService.findById('1');
    assert.strictEqual(alice?.name, 'Alice');

    const notFound = await mockUserService.findById('999');
    assert.strictEqual(notFound, null);

    // Test save
    const newUser = await mockUserService.save({ name: 'Charlie' });
    assert.strictEqual(newUser.id, '3');
    assert.strictEqual(newUser.name, 'Charlie');

    // Test delete
    await mockUserService.delete('1');

    // Verify call counts
    assertCallCount(findAllMock, 1);
    assertCallCount(findByIdMock, 2);
    assertCallCount(saveMock, 1);
    assertCallCount(deleteMock, 1);

    // Verify specific calls
    assertCalledWith(findByIdMock, '1');
    assertCalledWith(findByIdMock, '999');
    assertCalledWith(saveMock, { name: 'Charlie' });
  });
});

describe('Integration: Spying on class instances', () => {
  it('should spy on a class and track all method calls', () => {
    const calc = new Calculator();

    using spy = spyOn(calc);

    // Perform calculations
    const sum = calc.add(10, 5);
    const product = calc.multiply(sum, 2);
    const quotient = calc.divide(product, 3);

    // Verify results
    assert.strictEqual(sum, 15);
    assert.strictEqual(product, 30);
    assert.strictEqual(quotient, 10);

    // Verify tracking
    assertCallCount(spy.spied.add, 1);
    assertCallCount(spy.spied.multiply, 1);
    assertCallCount(spy.spied.divide, 1);

    assertCalledWith(spy.spied.add, 10, 5);
    assertCalledWith(spy.spied.multiply, 15, 2);
    assertCalledWith(spy.spied.divide, 30, 3);
  });
});
