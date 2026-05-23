/**
 * InMemoryTimerScheduler + TestClock.
 *
 * The InMemory scheduler is the test-first implementation used by
 * setupTestProcessRuntime. TestClock wraps it and adds .advance, .advanceTo,
 * .fireNext, .pendingTimers, etc.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { InMemoryTimerScheduler } from '../../runtime/process/timer-scheduler.js';
import { TestClock, createTestClock } from '../testing/clock.js';

describe('InMemoryTimerScheduler - core semantics', () => {
  let scheduler: InMemoryTimerScheduler;

  beforeEach(() => {
    scheduler = new InMemoryTimerScheduler();
  });

  afterEach(() => {
    scheduler.clear();
  });

  it('schedule() returns a unique timer id', async () => {
    const future = new Date(Date.now() + 60_000);
    const a = await scheduler.schedule('inst-1', future);
    const b = await scheduler.schedule('inst-1', future);
    assert.notEqual(a, b);
    assert.match(a, /^timer_/);
  });

  it('pendingCount reflects scheduled timers', async () => {
    await scheduler.schedule('a', new Date(Date.now() + 10_000));
    await scheduler.schedule('b', new Date(Date.now() + 20_000));
    assert.equal(scheduler.pendingCount, 2);
  });

  it('cancel removes a timer', async () => {
    const id = await scheduler.schedule('a', new Date(Date.now() + 10_000));
    assert.equal(scheduler.pendingCount, 1);
    await scheduler.cancel(id);
    assert.equal(scheduler.pendingCount, 0);
  });

  it('cancel on unknown id is a no-op', async () => {
    await scheduler.cancel('does-not-exist');
    assert.equal(scheduler.pendingCount, 0);
  });

  it('cancelAll removes only timers for the given instance', async () => {
    await scheduler.schedule('a', new Date(Date.now() + 10_000));
    await scheduler.schedule('a', new Date(Date.now() + 20_000));
    await scheduler.schedule('b', new Date(Date.now() + 30_000));
    await scheduler.cancelAll('a');
    assert.equal(scheduler.pendingCount, 1);
    assert.equal(scheduler.getTimers()[0].instanceId, 'b');
  });

  it('checkExpired returns only timers whose expiresAt <= now', async () => {
    const base = Date.now();
    await scheduler.schedule('a', new Date(base - 1000));   // past
    await scheduler.schedule('b', new Date(base + 60_000)); // future
    const fired = await scheduler.checkExpired(new Date(base));
    assert.equal(fired.length, 1);
    assert.equal(fired[0].instanceId, 'a');
    // "b" still pending
    assert.equal(scheduler.pendingCount, 1);
  });

  it('checkExpired fires callbacks registered via onFire', async () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    await scheduler.schedule('a', new Date(Date.now() - 1));
    await scheduler.checkExpired();
    assert.equal(fired.length, 1);
    assert.equal((fired[0] as any).instanceId, 'a');
  });

  it('onFire returns an unsubscribe that removes the callback', async () => {
    const calls: unknown[] = [];
    const unsubscribe = scheduler.onFire((t) => calls.push(t));
    await scheduler.schedule('a', new Date(Date.now() - 1));
    await scheduler.checkExpired();
    assert.equal(calls.length, 1);

    unsubscribe();
    await scheduler.schedule('b', new Date(Date.now() - 1));
    await scheduler.checkExpired();
    // Still 1 because unsubscribe removed the listener
    assert.equal(calls.length, 1);
  });

  it('receiveFire removes the timer and notifies listeners', () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    // Prime a timer synchronously in storage — pendingCount doesn't matter
    // since receiveFire can work on unknown ids too.
    scheduler.receiveFire({ timerId: 't1', instanceId: 'a' });
    assert.equal(fired.length, 1);
    assert.equal((fired[0] as any).instanceId, 'a');
  });

  it('fireNext fires an arbitrary single pending timer', async () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    await scheduler.schedule('a', new Date(Date.now() + 60_000));
    scheduler.fireNext();
    assert.equal(fired.length, 1);
    assert.equal(scheduler.pendingCount, 0);
  });

  it('fireNext on empty is a no-op', () => {
    scheduler.fireNext();
    assert.equal(scheduler.pendingCount, 0);
  });

  it('clear removes all timers and callbacks', async () => {
    scheduler.onFire(() => {});
    await scheduler.schedule('a', new Date(Date.now() + 60_000));
    scheduler.clear();
    assert.equal(scheduler.pendingCount, 0);
  });
});

describe('TestClock - time travel', () => {
  let scheduler: InMemoryTimerScheduler;
  let clock: TestClock;

  beforeEach(() => {
    scheduler = new InMemoryTimerScheduler();
    clock = new TestClock(scheduler, new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    scheduler.clear();
  });

  it('starts at the provided start time', () => {
    assert.equal(clock.now.getTime(), new Date('2024-01-01T00:00:00Z').getTime());
  });

  it('defaults to current wall-clock when no start time given', () => {
    const c = new TestClock(scheduler);
    // Just check it's within a small window
    assert.ok(Math.abs(c.now.getTime() - Date.now()) < 5_000);
  });

  it('advance.ms advances by milliseconds', async () => {
    await clock.advance.ms(500);
    assert.equal(clock.now.getTime(), new Date('2024-01-01T00:00:00.500Z').getTime());
  });

  it('advance.seconds fires timers that expire within window', async () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    await scheduler.schedule('a', new Date(clock.now.getTime() + 5_000));
    await clock.advance.seconds(10);
    assert.equal(fired.length, 1);
  });

  it('advance.minutes does not fire timers still in future', async () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    await scheduler.schedule('a', new Date(clock.now.getTime() + 10 * 60_000));
    await clock.advance.minutes(5);
    assert.equal(fired.length, 0);
  });

  it('advance.hours / .days do the obvious thing', async () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    await scheduler.schedule('h', new Date(clock.now.getTime() + 30 * 60_000));
    await clock.advance.hours(1);
    assert.equal(fired.length, 1);

    await scheduler.schedule('d', new Date(clock.now.getTime() + 12 * 3_600_000));
    await clock.advance.days(1);
    assert.equal(fired.length, 2);
  });

  it('advanceTo(past) throws', async () => {
    await assert.rejects(
      async () => clock.advanceTo(new Date('2023-01-01T00:00:00Z')),
      /Cannot go back in time/,
    );
  });

  it('advanceTo(future) fires all timers on or before target', async () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    await scheduler.schedule('t1', new Date(clock.now.getTime() + 1_000));
    await scheduler.schedule('t2', new Date(clock.now.getTime() + 2_000));
    await scheduler.schedule('t3', new Date(clock.now.getTime() + 10_000));

    await clock.advanceTo(new Date(clock.now.getTime() + 5_000));
    assert.equal(fired.length, 2);
  });

  it('nextTimer returns the earliest-expiring timer', async () => {
    await scheduler.schedule('later', new Date(clock.now.getTime() + 60_000));
    await scheduler.schedule('earliest', new Date(clock.now.getTime() + 10_000));
    await scheduler.schedule('middle', new Date(clock.now.getTime() + 30_000));
    assert.equal(clock.nextTimer?.instanceId, 'earliest');
  });

  it('nextTimer is undefined when empty', () => {
    assert.equal(clock.nextTimer, undefined);
  });

  it('timeToNextTimer reflects delta in ms', async () => {
    await scheduler.schedule('a', new Date(clock.now.getTime() + 3_000));
    assert.equal(clock.timeToNextTimer, 3_000);
  });

  it('timeToNextTimer is 0 when timer already expired', async () => {
    await scheduler.schedule('a', new Date(clock.now.getTime() - 1_000));
    assert.equal(clock.timeToNextTimer, 0);
  });

  it('advanceToNextTimer fires exactly the earliest timer', async () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    await scheduler.schedule('a', new Date(clock.now.getTime() + 1_000));
    await scheduler.schedule('b', new Date(clock.now.getTime() + 2_000));
    const result = await clock.advanceToNextTimer();
    assert.equal(result?.instanceId, 'a');
    assert.equal(fired.length, 1);
  });

  it('advanceToNextTimer returns undefined when empty', async () => {
    const r = await clock.advanceToNextTimer();
    assert.equal(r, undefined);
  });

  it('advanceToFireCount fires exactly N timers', async () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    for (let i = 0; i < 5; i++) {
      await scheduler.schedule(`t${i}`, new Date(clock.now.getTime() + (i + 1) * 1000));
    }
    await clock.advanceToFireCount(3);
    assert.equal(fired.length, 3);
    assert.equal(scheduler.pendingCount, 2);
  });

  it('advanceToFireCount stops at available timer count', async () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    await scheduler.schedule('x', new Date(clock.now.getTime() + 1000));
    await clock.advanceToFireCount(10);
    assert.equal(fired.length, 1);
  });

  it('fireAll drains all pending timers', async () => {
    const fired: unknown[] = [];
    scheduler.onFire((t) => fired.push(t));
    await scheduler.schedule('a', new Date(clock.now.getTime() + 100));
    await scheduler.schedule('b', new Date(clock.now.getTime() + 200));
    await scheduler.schedule('c', new Date(clock.now.getTime() + 300));
    clock.fireAll();
    assert.equal(fired.length, 3);
    assert.equal(scheduler.pendingCount, 0);
  });

  it('hasTimerWithin reports correctly', async () => {
    await scheduler.schedule('a', new Date(clock.now.getTime() + 5_000));
    assert.equal(clock.hasTimerWithin(10_000), true);
    assert.equal(clock.hasTimerWithin(1_000), false);
  });

  it('reset(time) moves the clock without firing timers', async () => {
    await scheduler.schedule('a', new Date(clock.now.getTime() + 1_000));
    clock.reset(new Date('2030-01-01'));
    assert.equal(scheduler.pendingCount, 1);
    assert.equal(clock.now.toISOString(), '2030-01-01T00:00:00.000Z');
  });

  it('createTestClock helper returns a TestClock', () => {
    const c = createTestClock(scheduler);
    assert.equal(c instanceof TestClock, true);
  });

  it('pendingTimers exposes the raw scheduler timers', async () => {
    await scheduler.schedule('a', new Date(clock.now.getTime() + 1_000));
    const timers = clock.pendingTimers;
    assert.equal(timers.length, 1);
    assert.equal(timers[0].instanceId, 'a');
  });
});
