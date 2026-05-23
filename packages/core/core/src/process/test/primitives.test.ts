/**
 * Primitives: signal(), race(), delay(), stream(), scope()
 *
 * These functions return "placeholder" objects that the compiler recognizes.
 * At runtime (without compiler transform), they produce tagged objects.
 * Tests verify tag shape, validation, narrowing behaviour, and edge inputs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  signal,
  race,
  delay,
  stream,
  scope,
  isSignalAllPlaceholder,
  isSignalSettledPlaceholder,
  isStreamPlaceholder,
  isScopePlaceholder,
  DurableArrayIterator,
  createDurableArrayIterator,
  isDurableIterable,
  DurableCursor,
  FromCursor,
} from '../primitives.js';

const SIGNAL_PLACEHOLDER = Symbol.for('@justscale/process/signal');
const RACE_PLACEHOLDER = Symbol.for('@justscale/process/race');
const DELAY_PLACEHOLDER = Symbol.for('@justscale/process/delay');

describe('signal() primitive', () => {
  it('single-arg form returns tagged placeholder holding target', () => {
    const fakeSig = { signalName: 's', __payload: null } as any;
    const result = signal(fakeSig) as any;
    assert.equal(result[SIGNAL_PLACEHOLDER], true);
    assert.equal(result.signal, fakeSig);
  });

  it('two-arg (race, target) form stores target as .signal', () => {
    const r = race();
    const fakeSig = { signalName: 's' } as any;
    const result = signal(r, fakeSig) as any;
    assert.equal(result[SIGNAL_PLACEHOLDER], true);
    assert.equal(result.signal, fakeSig);
  });

  it('two-arg form with explicit undefined racer throws (no coalescing fallback)', () => {
    // New strict behaviour: arity decides the overload, and passing
    // undefined for the target is a caller bug, not a legitimate fallback.
    const fakeSig = { signalName: 's' } as any;
    assert.throws(
      () => signal(undefined as unknown, fakeSig),
      /signal\(\) target is undefined/,
    );
  });

  it('two-arg form with explicit undefined target throws', () => {
    const fakeSig = { signalName: 's' } as any;
    assert.throws(
      () => signal(fakeSig, undefined as any),
      /signal\(\) target is undefined/,
    );
  });

  it('signal.all returns tagged all-placeholder with array', () => {
    const sigs = [{ signalName: 'a' } as any, { signalName: 'b' } as any] as const;
    const result = signal.all(sigs) as any;
    assert.equal(isSignalAllPlaceholder(result), true);
    assert.equal(result.isRace, false);
    assert.deepEqual(result.signals, sigs);
  });

  it('signal.all with object form preserves shape', () => {
    const group = { x: { signalName: 'a' } as any, y: { signalName: 'b' } as any };
    const result = signal.all(group) as any;
    assert.equal(isSignalAllPlaceholder(result), true);
    assert.equal(result.signals, group);
  });

  it('signal.all with race (two args) marks isRace=true', () => {
    const r = race();
    const sigs = [{ signalName: 'a' } as any];
    const result = signal.all(r, sigs) as any;
    assert.equal(result.isRace, true);
    assert.equal(result.signals, sigs);
  });

  it('signal.settled returns tagged settled-placeholder', () => {
    const sigs = [{ signalName: 'a' } as any];
    const result = signal.settled(sigs) as any;
    assert.equal(isSignalSettledPlaceholder(result), true);
    assert.equal(result.signals, sigs);
  });

  it('isSignalAllPlaceholder rejects non-objects', () => {
    assert.equal(isSignalAllPlaceholder(null), false);
    assert.equal(isSignalAllPlaceholder(undefined), false);
    assert.equal(isSignalAllPlaceholder('str'), false);
    assert.equal(isSignalAllPlaceholder(42), false);
    assert.equal(isSignalAllPlaceholder({}), false);
  });

  it('isSignalSettledPlaceholder rejects non-objects', () => {
    assert.equal(isSignalSettledPlaceholder(null), false);
    assert.equal(isSignalSettledPlaceholder({}), false);
  });
});

describe('race() primitive', () => {
  it('returns a tagged placeholder object', () => {
    const r = race() as any;
    assert.equal(r[RACE_PLACEHOLDER], true);
  });

  it('each call produces a fresh object (no shared singleton)', () => {
    const a = race();
    const b = race();
    assert.notEqual(a, b);
  });
});

describe('delay.seconds/minutes/hours/days', () => {
  it('delay.seconds(n) produces placeholder with correct ms', () => {
    const d = delay.seconds(5) as any;
    assert.equal(d[DELAY_PLACEHOLDER], true);
    assert.equal(d.unit, 'seconds');
    assert.equal(d.duration.ms, 5_000);
  });

  it('delay.minutes(n) scales by 60*1000', () => {
    const d = delay.minutes(2) as any;
    assert.equal(d.duration.ms, 120_000);
    assert.equal(d.unit, 'minutes');
  });

  it('delay.hours(n) scales by 3_600_000', () => {
    const d = delay.hours(3) as any;
    assert.equal(d.duration.ms, 3 * 3_600_000);
    assert.equal(d.unit, 'hours');
  });

  it('delay.days(n) scales by 86_400_000', () => {
    const d = delay.days(1) as any;
    assert.equal(d.duration.ms, 86_400_000);
    assert.equal(d.unit, 'days');
  });

  it('delay.seconds(0) is valid and yields 0 ms', () => {
    const d = delay.seconds(0) as any;
    assert.equal(d.duration.ms, 0);
  });

  it('delay.seconds(-1) throws (non-negative required)', () => {
    assert.throws(() => delay.seconds(-1), /non-negative/);
  });

  it('delay.minutes(NaN) throws (finite required)', () => {
    assert.throws(() => delay.minutes(NaN), /finite/);
  });

  it('delay.hours(Infinity) throws (finite required)', () => {
    assert.throws(() => delay.hours(Infinity), /finite/);
  });

  it('delay with two-arg (racer, n) form works the same', () => {
    const r = race();
    const d = delay.seconds(r, 7) as any;
    assert.equal(d.duration.ms, 7_000);
  });

  it('delay.days fractional produces correct ms (0.5 days = 12h)', () => {
    const d = delay.days(0.5) as any;
    assert.equal(d.duration.ms, 43_200_000);
  });

  it('delay with very large number still works (within safe integer range)', () => {
    const d = delay.seconds(1_000_000) as any;
    assert.equal(d.duration.ms, 1_000_000_000);
  });

  it('delay.seconds(null) throws (not a number)', () => {
    // @ts-expect-error testing invalid input
    assert.throws(() => delay.seconds(null), /finite number/);
  });

  it('delay.seconds(undefined) throws (not a number)', () => {
    // @ts-expect-error testing invalid input
    assert.throws(() => delay.seconds(undefined), /finite number/);
  });

  it('delay.seconds("5") throws (string is not accepted)', () => {
    // @ts-expect-error testing invalid input
    assert.throws(() => delay.seconds('5'), /finite number/);
  });
});

describe('stream() primitive', () => {
  it('produces a tagged stream placeholder holding the target iterable', () => {
    const r = race();
    const target = (async function* () {})();
    const result = stream(r, target) as any;
    assert.equal(isStreamPlaceholder(result), true);
    assert.equal(result.stream, target);
  });

  it('isStreamPlaceholder rejects non-objects', () => {
    assert.equal(isStreamPlaceholder(null), false);
    assert.equal(isStreamPlaceholder(42), false);
    assert.equal(isStreamPlaceholder('no'), false);
  });
});

describe('scope() primitive', () => {
  it('signal-first form: scope(signal, entities) returns signal-typed placeholder', () => {
    const fakeSignal = { then: () => {} } as any;
    const entities = [{ id: '1' }];
    const result = scope(fakeSignal, entities) as any;
    assert.equal(isScopePlaceholder(result), true);
    assert.equal(result.type, 'signal');
    assert.equal(result.signal, fakeSignal);
    assert.equal(result.entities, entities);
  });

  it('entities-first form with handler returns handler-typed placeholder', () => {
    const entities = [{ id: '1' }];
    const handler = async () => 'done';
    const result = scope(entities, handler) as any;
    assert.equal(result.type, 'handler');
    assert.equal(result.entities, entities);
    assert.equal(result.handler, handler);
  });

  it('entities-first with alias + handler captures idFnOrAlias', () => {
    const entities = [{ id: '1' }];
    const handler = async () => 42;
    const result = scope(entities, 'item', handler) as any;
    assert.equal(result.type, 'handler');
    assert.equal(result.idFnOrAlias, 'item');
  });

  it('single-arg scope() throws "Invalid scope arguments"', () => {
    // @ts-expect-error testing invalid input
    assert.throws(() => scope([{}]), /Invalid scope\(\) arguments/);
  });

  it('zero-arg scope() throws', () => {
    // @ts-expect-error testing invalid input
    assert.throws(() => scope(), /Invalid scope\(\) arguments/);
  });
});

describe('DurableArrayIterator', () => {
  it('iterates items from index 0 when no cursor given', async () => {
    const it = new DurableArrayIterator([1, 2, 3]);
    const collected: number[] = [];
    for await (const v of it) collected.push(v);
    assert.deepEqual(collected, [1, 2, 3]);
  });

  it('resumes from a finite integer cursor', async () => {
    const it = new DurableArrayIterator([10, 20, 30, 40], 2);
    const collected: number[] = [];
    for await (const v of it) collected.push(v);
    assert.deepEqual(collected, [30, 40]);
  });

  it('clamps cursor past end to done position', async () => {
    const it = new DurableArrayIterator([10, 20], 99);
    const result = await it.next();
    assert.equal(result.done, true);
  });

  it('floors non-integer cursors', async () => {
    const it = new DurableArrayIterator([1, 2, 3], 1.9);
    const first = await it.next();
    // 1.9 floors to 1, so next() returns items[1] = 2
    assert.equal(first.value, 2);
  });

  it('NaN cursor resets to 0', async () => {
    const it = new DurableArrayIterator(['a', 'b'], NaN);
    const first = await it.next();
    assert.equal(first.value, 'a');
  });

  it('negative cursor clamps to 0', async () => {
    const it = new DurableArrayIterator(['a', 'b'], -5);
    const first = await it.next();
    assert.equal(first.value, 'a');
  });

  it('string cursor resets to 0 (not a finite number)', async () => {
    const it = new DurableArrayIterator([1, 2], 'bad' as any);
    const first = await it.next();
    assert.equal(first.value, 1);
  });

  it('[DurableCursor] reflects current index after iteration', async () => {
    const it = new DurableArrayIterator([1, 2, 3]);
    await it.next(); // index -> 1
    await it.next(); // index -> 2
    assert.equal(it[DurableCursor](), 2);
  });

  it('[FromCursor] produces a new iterator at the saved cursor', async () => {
    const it = new DurableArrayIterator([1, 2, 3, 4]);
    const resumed = it[FromCursor](2);
    const first = await resumed.next();
    assert.equal(first.value, 3);
  });

  it('createDurableArrayIterator helper mirrors the class', async () => {
    const it = createDurableArrayIterator(['x', 'y'], 1);
    const first = await it.next();
    assert.equal(first.value, 'y');
  });

  it('isDurableIterable detects the protocol', () => {
    const it = new DurableArrayIterator([1]);
    assert.equal(isDurableIterable(it), true);
    assert.equal(isDurableIterable({}), false);
    assert.equal(isDurableIterable(null), false);
    assert.equal(isDurableIterable([1, 2]), false);
  });

  it('empty array iterator is immediately done', async () => {
    const it = new DurableArrayIterator<number>([]);
    const r = await it.next();
    assert.equal(r.done, true);
  });
});
