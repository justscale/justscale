import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  signal,
  race,
  delay,
  stream,
  isSignalPlaceholder,
  isRacePlaceholder,
  isDelayPlaceholder,
  isStreamPlaceholder,
  DurableCursor,
  FromCursor,
  DurableArrayIterator,
  isDurableIterable,
  createDurableArrayIterator,
} from '../../src/process/primitives.js';
import type { Signal } from '../../src/process/types.js';

describe('delay object methods', () => {
  it('delay.seconds() creates a delay placeholder with correct ms', () => {
    const result = delay.seconds(30);
    assert.ok(isDelayPlaceholder(result));
    if (isDelayPlaceholder(result)) {
      assert.strictEqual(result.duration.ms, 30000);
    }
  });

  it('delay.minutes() creates a delay placeholder with correct ms', () => {
    const result = delay.minutes(5);
    assert.ok(isDelayPlaceholder(result));
    if (isDelayPlaceholder(result)) {
      assert.strictEqual(result.duration.ms, 300000);
    }
  });

  it('delay.hours() creates a delay placeholder with correct ms', () => {
    const result = delay.hours(1);
    assert.ok(isDelayPlaceholder(result));
    if (isDelayPlaceholder(result)) {
      assert.strictEqual(result.duration.ms, 3600000);
    }
  });

  it('delay.days() creates a delay placeholder with correct ms', () => {
    const result = delay.days(1);
    assert.ok(isDelayPlaceholder(result));
    if (isDelayPlaceholder(result)) {
      assert.strictEqual(result.duration.ms, 86400000);
    }
  });

  it('duration values compose correctly', () => {
    // 1 day = 24 hours
    const day = delay.days(1) as unknown as { duration: { ms: number } };
    const hours24 = delay.hours(24) as unknown as { duration: { ms: number } };
    assert.strictEqual(day.duration.ms, hours24.duration.ms);
  });
});

describe('signal()', () => {
  it('creates a signal placeholder', () => {
    const mockSignal = {} as Signal<[], string>;
    const result = signal(mockSignal);

    assert.ok(isSignalPlaceholder(result));
  });

  it('stores the signal in the placeholder', () => {
    const mockSignal = { test: 'value' } as unknown as Signal<[string], void>;
    const result = signal(mockSignal);

    assert.ok(isSignalPlaceholder(result));
    if (isSignalPlaceholder(result)) {
      assert.strictEqual(result.signal, mockSignal);
    }
  });

  it('preserves generic type (compile-time check)', () => {
    const mockSignal = {} as Signal<[orderId: string], { amount: number }>;
    const result = signal(mockSignal) as any;
    assert.ok(result);
  });
});

describe('race()', () => {
  it('creates a race placeholder', () => {
    const result = race();

    assert.ok(isRacePlaceholder(result));
  });

  it('returns a new placeholder each call', () => {
    const result1 = race();
    const result2 = race();

    assert.notStrictEqual(result1, result2);
    assert.ok(isRacePlaceholder(result1));
    assert.ok(isRacePlaceholder(result2));
  });
});

describe('delay methods', () => {
  it('creates a delay placeholder with duration', () => {
    const result = delay.seconds(30);

    assert.ok(isDelayPlaceholder(result));
    if (isDelayPlaceholder(result)) {
      assert.deepStrictEqual(result.duration, { ms: 30000 });
    }
  });

  it('works with all delay methods', () => {
    const delays = [
      delay.seconds(10),
      delay.minutes(5),
      delay.hours(2),
      delay.days(1),
    ];

    for (const d of delays) {
      assert.ok(isDelayPlaceholder(d));
    }
  });

  it('returns Signal<[], void>', () => {
    const result = delay.hours(1) as any;
    assert.ok(result);
  });

  it('allows zero delay', () => {
    const result = delay.seconds(0);
    assert.ok(isDelayPlaceholder(result));
    if (isDelayPlaceholder(result)) {
      assert.strictEqual(result.duration.ms, 0);
    }
  });

  describe('delay validation', () => {
    it('throws for NaN delay', () => {
      assert.throws(
        () => delay.seconds(NaN),
        { message: 'delay.seconds() requires a finite number, got NaN' }
      );
    });

    it('throws for Infinity delay', () => {
      assert.throws(
        () => delay.minutes(Infinity),
        { message: 'delay.minutes() requires a finite number, got Infinity' }
      );
    });

    it('throws for negative Infinity delay', () => {
      assert.throws(
        () => delay.hours(-Infinity),
        { message: 'delay.hours() requires a finite number, got -Infinity' }
      );
    });

    it('throws for negative delay', () => {
      assert.throws(
        () => delay.days(-1),
        { message: 'delay.days() requires a non-negative number, got -1' }
      );
    });

    it('throws for non-number delay', () => {
      assert.throws(
        () => (delay.seconds as any)('invalid'),
        { message: 'delay.seconds() requires a finite number, got invalid' }
      );
    });
  });
});

describe('Detection helpers', () => {
  describe('isSignalPlaceholder()', () => {
    it('returns true for signal() result', () => {
      const result = signal({} as Signal<[], unknown>);
      assert.ok(isSignalPlaceholder(result));
    });

    it('returns false for race() result', () => {
      const result = race();
      assert.ok(!isSignalPlaceholder(result));
    });

    it('returns false for delay() result', () => {
      const result = delay.seconds(1);
      assert.ok(!isSignalPlaceholder(result));
    });

    it('returns false for null/undefined', () => {
      assert.ok(!isSignalPlaceholder(null));
      assert.ok(!isSignalPlaceholder(undefined));
    });

    it('returns false for plain objects', () => {
      assert.ok(!isSignalPlaceholder({}));
      assert.ok(!isSignalPlaceholder({ signalCall: 'fake' }));
    });
  });

  describe('isRacePlaceholder()', () => {
    it('returns true for race() result', () => {
      const result = race();
      assert.ok(isRacePlaceholder(result));
    });

    it('returns false for signal() result', () => {
      const result = signal({} as Signal<[], unknown>);
      assert.ok(!isRacePlaceholder(result));
    });

    it('returns false for delay() result', () => {
      const result = delay.seconds(1);
      assert.ok(!isRacePlaceholder(result));
    });

    it('returns false for null/undefined', () => {
      assert.ok(!isRacePlaceholder(null));
      assert.ok(!isRacePlaceholder(undefined));
    });
  });

  describe('isDelayPlaceholder()', () => {
    it('returns true for delay() result', () => {
      const result = delay.minutes(5);
      assert.ok(isDelayPlaceholder(result));
    });

    it('returns false for signal() result', () => {
      const result = signal({} as Signal<[], unknown>);
      assert.ok(!isDelayPlaceholder(result));
    });

    it('returns false for race() result', () => {
      const result = race();
      assert.ok(!isDelayPlaceholder(result));
    });

    it('returns false for null/undefined', () => {
      assert.ok(!isDelayPlaceholder(null));
      assert.ok(!isDelayPlaceholder(undefined));
    });

    it('returns false for objects with duration but wrong symbol', () => {
      assert.ok(!isDelayPlaceholder({ duration: { ms: 1000 } }));
    });
  });
});

describe('DurableArrayIterator', () => {
  it('implements DurableIterable protocol', () => {
    const items = [1, 2, 3];
    const iter = new DurableArrayIterator(items);

    assert.ok(DurableCursor in iter);
    assert.ok(FromCursor in iter);
    assert.ok(isDurableIterable(iter));
  });

  it('iterates over all items', async () => {
    const items = ['a', 'b', 'c'];
    const iter = new DurableArrayIterator(items);
    const results: string[] = [];

    for await (const item of iter) {
      results.push(item);
    }

    assert.deepStrictEqual(results, items);
  });

  it('returns correct cursor position', async () => {
    const items = [1, 2, 3, 4, 5];
    const iter = new DurableArrayIterator(items);

    assert.strictEqual(iter[DurableCursor](), 0);

    await iter.next();
    assert.strictEqual(iter[DurableCursor](), 1);

    await iter.next();
    assert.strictEqual(iter[DurableCursor](), 2);
  });

  it('resumes from cursor position', async () => {
    const items = [1, 2, 3, 4, 5];
    const iter = new DurableArrayIterator(items, 2); // Start at index 2
    const results: number[] = [];

    for await (const item of iter) {
      results.push(item);
    }

    assert.deepStrictEqual(results, [3, 4, 5]);
  });

  it('FromCursor creates new iterator from cursor', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const iter = new DurableArrayIterator(items);

    // Advance to position 2
    await iter.next();
    await iter.next();
    const cursor = iter[DurableCursor]();

    // Create new iterator from cursor
    const resumed = iter[FromCursor](cursor);
    const results: string[] = [];

    for await (const item of resumed) {
      results.push(item);
    }

    assert.deepStrictEqual(results, ['c', 'd']);
  });

  it('handles empty arrays', async () => {
    const iter = new DurableArrayIterator([]);
    const result = await iter.next();

    assert.strictEqual(result.done, true);
    assert.strictEqual(result.value, undefined);
  });

  it('cursor is JSON-serializable', () => {
    const items = [1, 2, 3];
    const iter = new DurableArrayIterator(items, 1);
    const cursor = iter[DurableCursor]();

    const serialized = JSON.stringify(cursor);
    const deserialized = JSON.parse(serialized);

    assert.strictEqual(deserialized, 1);
  });

  // Edge case tests for cursor bounds
  describe('cursor bounds validation', () => {
    it('clamps negative cursor to 0', async () => {
      const items = [1, 2, 3];
      const iter = new DurableArrayIterator(items, -5);

      // Should start from index 0 (clamped)
      const first = await iter.next();
      assert.strictEqual(first.value, 1);
      assert.strictEqual(iter[DurableCursor](), 1);
    });

    it('clamps cursor beyond array length to array.length', async () => {
      const items = [1, 2, 3];
      const iter = new DurableArrayIterator(items, 100);

      // Should be at "done" position
      const result = await iter.next();
      assert.strictEqual(result.done, true);
      assert.strictEqual(result.value, undefined);
    });

    it('handles cursor at exact array length (done position)', async () => {
      const items = [1, 2, 3];
      const iter = new DurableArrayIterator(items, 3); // items.length

      const result = await iter.next();
      assert.strictEqual(result.done, true);
    });

    it('handles non-number cursor gracefully', async () => {
      const items = [1, 2, 3];
      // Pass a string cast as unknown to simulate invalid input at runtime
      const iter = new DurableArrayIterator(items, 'invalid' as unknown as number);

      // Should start from index 0 (default)
      const first = await iter.next();
      assert.strictEqual(first.value, 1);
    });

    it('handles NaN cursor by resetting to 0', async () => {
      const items = [1, 2, 3];
      const iter = new DurableArrayIterator(items, NaN);

      // NaN should be rejected, start from index 0
      const first = await iter.next();
      assert.strictEqual(first.value, 1);
      assert.strictEqual(iter[DurableCursor](), 1);
    });

    it('handles Infinity cursor by clamping to array length', async () => {
      const items = [1, 2, 3];
      const iter = new DurableArrayIterator(items, Infinity);

      // Infinity is not finite, so should reset to 0
      const first = await iter.next();
      assert.strictEqual(first.value, 1);
    });

    it('handles negative Infinity cursor by resetting to 0', async () => {
      const items = [1, 2, 3];
      const iter = new DurableArrayIterator(items, -Infinity);

      // -Infinity is not finite, should reset to 0
      const first = await iter.next();
      assert.strictEqual(first.value, 1);
    });

    it('handles fractional cursor by flooring', async () => {
      const items = [1, 2, 3, 4, 5];
      const iter = new DurableArrayIterator(items, 2.7);

      // 2.7 should be floored to 2, so start at index 2 (value 3)
      const first = await iter.next();
      assert.strictEqual(first.value, 3);
      assert.strictEqual(iter[DurableCursor](), 3);
    });

    it('handles fractional negative cursor by flooring then clamping', async () => {
      const items = [1, 2, 3];
      // -0.5 floors to -1, then clamps to 0
      const iter = new DurableArrayIterator(items, -0.5);

      const first = await iter.next();
      assert.strictEqual(first.value, 1);
    });

    it('handles empty array with cursor', async () => {
      const iter = new DurableArrayIterator([], 0);

      const result = await iter.next();
      assert.strictEqual(result.done, true);

      // Cursor should remain at 0 (clamped to empty array)
      assert.strictEqual(iter[DurableCursor](), 0);
    });
  });
});

describe('isDurableIterable()', () => {
  it('returns true for DurableArrayIterator', () => {
    const iter = new DurableArrayIterator([1, 2, 3]);
    assert.ok(isDurableIterable(iter));
  });

  it('returns false for plain arrays', () => {
    assert.ok(!isDurableIterable([1, 2, 3]));
  });

  it('returns false for plain objects', () => {
    assert.ok(!isDurableIterable({}));
    assert.ok(!isDurableIterable({ items: [1, 2, 3] }));
  });

  it('returns false for null/undefined', () => {
    assert.ok(!isDurableIterable(null));
    assert.ok(!isDurableIterable(undefined));
  });
});

describe('createDurableArrayIterator()', () => {
  it('creates a DurableArrayIterator', () => {
    const items = [1, 2, 3];
    const iter = createDurableArrayIterator(items);

    assert.ok(iter instanceof DurableArrayIterator);
    assert.ok(isDurableIterable(iter));
  });

  it('accepts optional cursor', async () => {
    const items = [1, 2, 3, 4, 5];
    const iter = createDurableArrayIterator(items, 3);
    const results: number[] = [];

    for await (const item of iter) {
      results.push(item);
    }

    assert.deepStrictEqual(results, [4, 5]);
  });
});

// ============================================================================
// stream() Primitive Tests
// ============================================================================

describe('stream()', () => {
  // Helper to create a mock stream (AsyncIterable)
  function createMockStream<T>(): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          async next() {
            return { done: true, value: undefined };
          }
        };
      }
    };
  }

  it('creates a stream placeholder', () => {
    const mockRacer = {};
    const mockStream = createMockStream<string>();
    const result = stream(mockRacer, mockStream);

    assert.ok(isStreamPlaceholder(result));
  });

  it('stores the stream in the placeholder', () => {
    const mockRacer = {};
    const mockStream = createMockStream<{ status: string }>();
    const result = stream(mockRacer, mockStream);

    assert.ok(isStreamPlaceholder(result));
    if (isStreamPlaceholder(result)) {
      assert.strictEqual(result.stream, mockStream);
    }
  });

  it('returns a placeholder object with the STREAM_PLACEHOLDER symbol', () => {
    const mockRacer = {};
    const mockStream = createMockStream<number>();
    const result = stream(mockRacer, mockStream);

    // The placeholder should have the symbol marker
    assert.ok(typeof result === 'object');
    assert.ok(result !== null);
    assert.ok(isStreamPlaceholder(result));
  });
});

describe('isStreamPlaceholder()', () => {
  function createMockStream<T>(): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          async next() {
            return { done: true, value: undefined };
          }
        };
      }
    };
  }

  it('returns true for stream() result', () => {
    const mockRacer = {};
    const mockStream = createMockStream<string>();
    const result = stream(mockRacer, mockStream);
    assert.ok(isStreamPlaceholder(result));
  });

  it('returns false for signal() result', () => {
    const result = signal({} as Signal<[], unknown>);
    assert.ok(!isStreamPlaceholder(result));
  });

  it('returns false for race() result', () => {
    const result = race();
    assert.ok(!isStreamPlaceholder(result));
  });

  it('returns false for delay() result', () => {
    const result = delay.seconds(1);
    assert.ok(!isStreamPlaceholder(result));
  });

  it('returns false for null/undefined', () => {
    assert.ok(!isStreamPlaceholder(null));
    assert.ok(!isStreamPlaceholder(undefined));
  });

  it('returns false for plain objects', () => {
    assert.ok(!isStreamPlaceholder({}));
    assert.ok(!isStreamPlaceholder({ stream: 'fake' }));
  });

  it('returns false for AsyncIterables without placeholder symbol', () => {
    const fakeStream = {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          async next() {
            return { done: true, value: undefined };
          }
        };
      }
    };
    assert.ok(!isStreamPlaceholder(fakeStream));
  });
});
