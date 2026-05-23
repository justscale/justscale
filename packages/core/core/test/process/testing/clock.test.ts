/**
 * Tests for the TestClock time travel utility.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { InMemoryTimerScheduler } from '../../../src/runtime/process/timer-scheduler.js';
import { TestClock, createTestClock } from '../../../src/process/testing/clock.js';

describe('TestClock', () => {
  let scheduler: InMemoryTimerScheduler;
  let clock: TestClock;

  beforeEach(() => {
    scheduler = new InMemoryTimerScheduler();
    clock = new TestClock(scheduler, new Date('2025-01-01T00:00:00Z'));
  });

  describe('initialization', () => {
    it('should start at the provided time', () => {
      const startTime = new Date('2025-06-15T12:00:00Z');
      const c = new TestClock(scheduler, startTime);
      assert.strictEqual(c.now.getTime(), startTime.getTime());
    });

    it('should start at current time if not provided', () => {
      const before = Date.now();
      const c = new TestClock(scheduler);
      const after = Date.now();

      assert.ok(c.now.getTime() >= before);
      assert.ok(c.now.getTime() <= after);
    });
  });

  describe('advance.seconds()', () => {
    it('should advance time by seconds', async () => {
      const initial = clock.now.getTime();
      await clock.advance.seconds(30);
      assert.strictEqual(clock.now.getTime(), initial + 30 * 1000);
    });

    it('should fire timers that expire', async () => {
      // Schedule a timer 10 seconds from now
      const timerId = await scheduler.schedule(
        'test-instance',
        new Date(clock.now.getTime() + 10 * 1000)
      );

      let firedTimerId: string | undefined;
      scheduler.onFire((fired) => {
        firedTimerId = fired.timerId;
      });

      // Advance 15 seconds - timer should fire
      await clock.advance.seconds(15);

      assert.strictEqual(firedTimerId, timerId);
      assert.strictEqual(clock.pendingCount, 0);
    });
  });

  describe('advance.minutes()', () => {
    it('should advance time by minutes', async () => {
      const initial = clock.now.getTime();
      await clock.advance.minutes(5);
      assert.strictEqual(clock.now.getTime(), initial + 5 * 60 * 1000);
    });
  });

  describe('advance.hours()', () => {
    it('should advance time by hours', async () => {
      const initial = clock.now.getTime();
      await clock.advance.hours(2);
      assert.strictEqual(clock.now.getTime(), initial + 2 * 60 * 60 * 1000);
    });
  });

  describe('advance.days()', () => {
    it('should advance time by days', async () => {
      const initial = clock.now.getTime();
      await clock.advance.days(7);
      assert.strictEqual(clock.now.getTime(), initial + 7 * 24 * 60 * 60 * 1000);
    });
  });

  describe('advanceTo()', () => {
    it('should advance to specific time', async () => {
      const target = new Date('2025-02-01T00:00:00Z');
      await clock.advanceTo(target);
      assert.strictEqual(clock.now.getTime(), target.getTime());
    });

    it('should throw when trying to go back in time', async () => {
      await assert.rejects(
        clock.advanceTo(new Date('2024-01-01T00:00:00Z')),
        /Cannot go back in time/
      );
    });

    it('should fire multiple timers in order', async () => {
      const firedIds: string[] = [];
      scheduler.onFire((fired) => firedIds.push(fired.timerId));

      // Schedule timers at different times
      const t1 = await scheduler.schedule('inst-1', new Date('2025-01-01T01:00:00Z'));
      const t2 = await scheduler.schedule('inst-2', new Date('2025-01-01T02:00:00Z'));
      const t3 = await scheduler.schedule('inst-3', new Date('2025-01-01T03:00:00Z'));

      // Advance past all timers
      await clock.advanceTo(new Date('2025-01-01T04:00:00Z'));

      assert.strictEqual(firedIds.length, 3);
      assert.deepStrictEqual(firedIds, [t1, t2, t3]);
    });
  });

  describe('fireNext()', () => {
    it('should fire next timer regardless of time', async () => {
      let firedTimerId: string | undefined;
      scheduler.onFire((fired) => {
        firedTimerId = fired.timerId;
      });

      // Schedule timer far in the future
      const timerId = await scheduler.schedule(
        'test-instance',
        new Date('2099-01-01T00:00:00Z')
      );

      // Fire it immediately
      clock.fireNext();

      assert.strictEqual(firedTimerId, timerId);
      assert.strictEqual(clock.pendingCount, 0);
    });

    it('should do nothing if no timers pending', () => {
      // Should not throw
      clock.fireNext();
      assert.strictEqual(clock.pendingCount, 0);
    });
  });

  describe('fireAll()', () => {
    it('should fire all pending timers', async () => {
      const firedIds: string[] = [];
      scheduler.onFire((fired) => firedIds.push(fired.timerId));

      await scheduler.schedule('inst-1', new Date('2025-06-01T00:00:00Z'));
      await scheduler.schedule('inst-2', new Date('2025-07-01T00:00:00Z'));
      await scheduler.schedule('inst-3', new Date('2025-08-01T00:00:00Z'));

      clock.fireAll();

      assert.strictEqual(firedIds.length, 3);
      assert.strictEqual(clock.pendingCount, 0);
    });
  });

  describe('pendingTimers', () => {
    it('should return all pending timers', async () => {
      await scheduler.schedule('inst-1', new Date('2025-06-01T00:00:00Z'));
      await scheduler.schedule('inst-2', new Date('2025-07-01T00:00:00Z'));

      const timers = clock.pendingTimers;
      assert.strictEqual(timers.length, 2);
      assert.strictEqual(timers[0].instanceId, 'inst-1');
      assert.strictEqual(timers[1].instanceId, 'inst-2');
    });
  });

  describe('nextTimer', () => {
    it('should return the earliest timer', async () => {
      await scheduler.schedule('inst-later', new Date('2025-06-01T00:00:00Z'));
      await scheduler.schedule('inst-earlier', new Date('2025-03-01T00:00:00Z'));

      const next = clock.nextTimer;
      assert.ok(next);
      assert.strictEqual(next.instanceId, 'inst-earlier');
    });

    it('should return undefined when no timers', () => {
      assert.strictEqual(clock.nextTimer, undefined);
    });
  });

  describe('timeToNextTimer', () => {
    it('should return time until next timer', async () => {
      await scheduler.schedule(
        'inst-1',
        new Date(clock.now.getTime() + 5 * 60 * 1000) // 5 minutes from now
      );

      const timeToNext = clock.timeToNextTimer;
      assert.strictEqual(timeToNext, 5 * 60 * 1000);
    });

    it('should return undefined when no timers', () => {
      assert.strictEqual(clock.timeToNextTimer, undefined);
    });
  });

  describe('advanceToNextTimer()', () => {
    it('should advance exactly to next timer and fire it', async () => {
      let firedTimerId: string | undefined;
      scheduler.onFire((fired) => {
        firedTimerId = fired.timerId;
      });

      const targetTime = new Date('2025-01-15T00:00:00Z');
      const timerId = await scheduler.schedule('inst-1', targetTime);

      const fired = await clock.advanceToNextTimer();

      assert.ok(fired);
      assert.strictEqual(fired.timerId, timerId);
      assert.strictEqual(clock.now.getTime(), targetTime.getTime());
    });

    it('should return undefined when no timers', async () => {
      const fired = await clock.advanceToNextTimer();
      assert.strictEqual(fired, undefined);
    });
  });

  describe('advanceToFireCount()', () => {
    it('should fire exactly n timers', async () => {
      const firedIds: string[] = [];
      scheduler.onFire((fired) => firedIds.push(fired.instanceId));

      await scheduler.schedule('inst-1', new Date('2025-02-01T00:00:00Z'));
      await scheduler.schedule('inst-2', new Date('2025-03-01T00:00:00Z'));
      await scheduler.schedule('inst-3', new Date('2025-04-01T00:00:00Z'));

      const fired = await clock.advanceToFireCount(2);

      assert.strictEqual(fired.length, 2);
      assert.strictEqual(firedIds.length, 2);
      assert.strictEqual(clock.pendingCount, 1); // One timer still pending
    });
  });

  describe('hasTimerWithin()', () => {
    it('should return true if timer fires within duration', async () => {
      await scheduler.schedule(
        'inst-1',
        new Date(clock.now.getTime() + 5 * 60 * 1000) // 5 minutes
      );

      assert.strictEqual(clock.hasTimerWithin(10 * 60 * 1000), true); // 10 minutes
      assert.strictEqual(clock.hasTimerWithin(3 * 60 * 1000), false); // 3 minutes
    });
  });

  describe('reset()', () => {
    it('should reset clock to specific time', async () => {
      await clock.advance.hours(5);
      const newTime = new Date('2025-12-31T00:00:00Z');
      clock.reset(newTime);
      assert.strictEqual(clock.now.getTime(), newTime.getTime());
    });

    it('should reset to current time if not provided', () => {
      const before = Date.now();
      clock.reset();
      const after = Date.now();

      assert.ok(clock.now.getTime() >= before);
      assert.ok(clock.now.getTime() <= after);
    });
  });

  describe('createTestClock()', () => {
    it('should create a TestClock instance', () => {
      const c = createTestClock(scheduler);
      assert.ok(c instanceof TestClock);
    });
  });
});
