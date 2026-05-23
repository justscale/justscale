import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { InMemoryTimerScheduler, type TimerFired } from '../../../src/runtime/process/timer-scheduler.js';

describe('InMemoryTimerScheduler', () => {
  let scheduler: InMemoryTimerScheduler;

  beforeEach(() => {
    scheduler = new InMemoryTimerScheduler();
  });

  afterEach(() => {
    scheduler.clear();
  });

  describe('schedule()', () => {
    it('returns a unique timer ID', async () => {
      const future = new Date(Date.now() + 60000);
      const id1 = await scheduler.schedule('instance-1', future);
      const id2 = await scheduler.schedule('instance-2', future);

      assert.ok(id1);
      assert.ok(id2);
      assert.notStrictEqual(id1, id2);
    });

    it('increments timer count', async () => {
      const future = new Date(Date.now() + 60000);

      assert.strictEqual(scheduler.timerCount, 0);

      await scheduler.schedule('instance-1', future);
      assert.strictEqual(scheduler.timerCount, 1);

      await scheduler.schedule('instance-2', future);
      assert.strictEqual(scheduler.timerCount, 2);
    });

    it('stores branch ID when provided', async () => {
      const future = new Date(Date.now() + 60000);
      await scheduler.schedule('instance-1', future, 'timeout-branch');

      const timers = scheduler.getTimers();
      assert.strictEqual(timers.length, 1);
      assert.strictEqual(timers[0].branchId, 'timeout-branch');
    });
  });

  describe('cancel()', () => {
    it('removes a scheduled timer', async () => {
      const future = new Date(Date.now() + 60000);
      const timerId = await scheduler.schedule('instance-1', future);

      await scheduler.cancel(timerId);

      assert.strictEqual(scheduler.timerCount, 0);
    });

    it('handles non-existent timer gracefully', async () => {
      // Should not throw
      await scheduler.cancel('non-existent-id');
    });
  });

  describe('cancelAll()', () => {
    it('removes all timers for an instance', async () => {
      const future = new Date(Date.now() + 60000);

      await scheduler.schedule('instance-1', future);
      await scheduler.schedule('instance-1', new Date(Date.now() + 120000));
      await scheduler.schedule('instance-2', future);

      await scheduler.cancelAll('instance-1');

      assert.strictEqual(scheduler.timerCount, 1);
      const timers = scheduler.getTimers();
      assert.strictEqual(timers[0].instanceId, 'instance-2');
    });
  });

  describe('checkExpired()', () => {
    it('fires expired timers', async () => {
      const past = new Date(Date.now() - 60000);
      const future = new Date(Date.now() + 60000);

      await scheduler.schedule('instance-1', past);
      await scheduler.schedule('instance-2', future);

      const fired = await scheduler.checkExpired(new Date());

      assert.strictEqual(fired.length, 1);
      assert.strictEqual(fired[0].instanceId, 'instance-1');
    });

    it('removes fired timers', async () => {
      const past = new Date(Date.now() - 60000);
      await scheduler.schedule('instance-1', past);

      assert.strictEqual(scheduler.timerCount, 1);

      await scheduler.checkExpired(new Date());

      assert.strictEqual(scheduler.timerCount, 0);
    });

    it('includes branch ID in fired result', async () => {
      const past = new Date(Date.now() - 60000);
      await scheduler.schedule('instance-1', past, 'my-branch');

      const fired = await scheduler.checkExpired(new Date());

      assert.strictEqual(fired.length, 1);
      assert.strictEqual(fired[0].branchId, 'my-branch');
    });
  });

  describe('onFire()', () => {
    it('calls callback when timer fires via checkExpired', async () => {
      const fired: TimerFired[] = [];
      scheduler.onFire(f => fired.push(f));

      const past = new Date(Date.now() - 60000);
      await scheduler.schedule('instance-1', past);

      await scheduler.checkExpired(new Date());

      assert.strictEqual(fired.length, 1);
      assert.strictEqual(fired[0].instanceId, 'instance-1');
    });

    it('returns unsubscribe function', async () => {
      const fired: TimerFired[] = [];
      const unsub = scheduler.onFire(f => fired.push(f));

      const past = new Date(Date.now() - 60000);
      await scheduler.schedule('instance-1', past);

      unsub(); // Unsubscribe

      await scheduler.checkExpired(new Date());

      assert.strictEqual(fired.length, 0);
    });

    it('handles callback errors gracefully', async () => {
      scheduler.onFire(() => {
        throw new Error('Callback error');
      });

      const past = new Date(Date.now() - 60000);
      await scheduler.schedule('instance-1', past);

      // Should not throw
      await scheduler.checkExpired(new Date());
    });
  });

  describe('advanceTo() (testing utility)', () => {
    it('fires timers up to the given time', async () => {
      const now = new Date();
      const in5min = new Date(now.getTime() + 5 * 60 * 1000);
      const in10min = new Date(now.getTime() + 10 * 60 * 1000);

      await scheduler.schedule('instance-1', in5min);
      await scheduler.schedule('instance-2', in10min);

      const fired = await scheduler.advanceTo(new Date(now.getTime() + 7 * 60 * 1000));

      assert.strictEqual(fired.length, 1);
      assert.strictEqual(fired[0].instanceId, 'instance-1');
      assert.strictEqual(scheduler.timerCount, 1); // instance-2 still pending
    });
  });

  describe('start() and stop()', () => {
    it('schedules setTimeout when started', async (t) => {
      // Use a short timeout for testing
      const soon = new Date(Date.now() + 50); // 50ms from now

      const fired: TimerFired[] = [];
      scheduler.onFire(f => fired.push(f));

      await scheduler.schedule('instance-1', soon);
      scheduler.start();

      // Wait for the timer to fire
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(fired.length, 1);
      assert.strictEqual(fired[0].instanceId, 'instance-1');

      scheduler.stop();
    });

    it('stop() clears scheduled timeouts', async () => {
      const soon = new Date(Date.now() + 50);

      const fired: TimerFired[] = [];
      scheduler.onFire(f => fired.push(f));

      await scheduler.schedule('instance-1', soon);
      scheduler.start();
      scheduler.stop();

      // Wait past when timer would have fired
      await new Promise(resolve => setTimeout(resolve, 100));

      // Timer should not have fired because we stopped
      assert.strictEqual(fired.length, 0);
    });

    it('timers scheduled while running are immediately scheduled', async () => {
      scheduler.start();

      const soon = new Date(Date.now() + 50);
      const fired: TimerFired[] = [];
      scheduler.onFire(f => fired.push(f));

      await scheduler.schedule('instance-1', soon);

      // Wait for the timer to fire
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(fired.length, 1);

      scheduler.stop();
    });
  });

  describe('clear()', () => {
    it('removes all state', async () => {
      const future = new Date(Date.now() + 60000);
      await scheduler.schedule('instance-1', future);
      await scheduler.schedule('instance-2', future);
      scheduler.onFire(() => {});

      scheduler.clear();

      assert.strictEqual(scheduler.timerCount, 0);
    });
  });

  // --------------------------------------------------------------------------
  // Long-duration timers
  //
  // Node's setTimeout silently clamps delays above 2^31 - 1 ms to 1 ms and
  // emits a TimeoutOverflowWarning. A naive scheduler passing the raw delta
  // to setTimeout would have `delay.days(r, 30)` fire in ~1ms instead of 30
  // days - catastrophic for any durable process using long deadlines.
  // --------------------------------------------------------------------------

  describe('long-duration timers', () => {
    it('does not fire a 30-day timer during the first event-loop ticks', async () => {
      const warnings: string[] = [];
      const onWarn = (w: Error) => warnings.push(w.name);
      process.on('warning', onWarn);

      try {
        const fired: TimerFired[] = [];
        scheduler.onFire(f => fired.push(f));

        const in30days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await scheduler.schedule('instance-long', in30days);
        scheduler.start();

        // Let any clamped setTimeout(1) callbacks drain.
        await new Promise(resolve => setTimeout(resolve, 50));

        assert.strictEqual(
          fired.length,
          0,
          'A 30-day timer must not fire within 50ms. ' +
          'Node clamps setTimeout delays > 2^31 ms to 1ms; ' +
          'the scheduler must re-arm in chunks instead of passing the raw delta.',
        );
        assert.strictEqual(
          scheduler.timerCount,
          1,
          'The long timer must still be pending after 50ms.',
        );
        assert.ok(
          !warnings.includes('TimeoutOverflowWarning'),
          'Must not emit TimeoutOverflowWarning - means we passed > 2^31 ms to setTimeout.',
        );

        scheduler.stop();
      } finally {
        process.off('warning', onWarn);
      }
    });

    it('cancel() of a long timer stops it mid-chunk', async () => {
      const fired: TimerFired[] = [];
      scheduler.onFire(f => fired.push(f));

      const in30days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const id = await scheduler.schedule('instance-long', in30days);
      scheduler.start();

      await scheduler.cancel(id);

      // Tick past when a clamped setTimeout(1) would have delivered.
      await new Promise(resolve => setTimeout(resolve, 50));

      assert.strictEqual(fired.length, 0);
      assert.strictEqual(scheduler.timerCount, 0);

      scheduler.stop();
    });

    it('a short timer still fires at roughly its scheduled time', async () => {
      // Regression guard: the chunking path must not defer short timers.
      const fired: TimerFired[] = [];
      scheduler.onFire(f => fired.push(f));

      const start = Date.now();
      const in40ms = new Date(start + 40);
      await scheduler.schedule('instance-short', in40ms);
      scheduler.start();

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(fired.length, 1);
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed >= 35 && elapsed <= 200,
        `short timer must fire near 40ms; fired after ${elapsed}ms`,
      );

      scheduler.stop();
    });
  });

  // Edge cases: zero / negative delays. The agent flagged "negative
  // delay = infinite loop" as a possible bug. The scheduler clamps
  // setTimeout's first arg to 0 via Math.max, and the fire callback
  // re-arms only when remaining > 0 — so a stale/past expiresAt fires
  // once on next tick and is then deleted. Pin both behaviors.

  describe('edge-case delays', () => {
    it('zero-ms timer fires on next tick', async () => {
      const fired: TimerFired[] = [];
      scheduler.onFire(f => fired.push(f));

      await scheduler.schedule('instance-zero', new Date(Date.now()));
      scheduler.start();
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(fired.length, 1);
      assert.strictEqual(scheduler.timerCount, 0, 'timer must be deleted after fire');
      scheduler.stop();
    });

    it('past-dated timer (negative delay) fires once and does not loop', async () => {
      const fired: TimerFired[] = [];
      scheduler.onFire(f => fired.push(f));

      // expiresAt is 1 second in the past. The scheduler clamps via
      // Math.max(0, ...) so setTimeout gets 0; the fire callback then
      // sees remaining<=0 and emits exactly one fire event.
      await scheduler.schedule('instance-past', new Date(Date.now() - 1000));
      scheduler.start();
      await new Promise((r) => setTimeout(r, 80));

      assert.strictEqual(fired.length, 1, 'past-dated timer fires exactly once');
      assert.strictEqual(scheduler.timerCount, 0, 'no leak in timer map');
      scheduler.stop();
    });

    it('many concurrent past-dated timers all fire exactly once each', async () => {
      // Exercises the "fire then delete" path under burst: 50 stale
      // timers should all settle after one event-loop pass.
      const fired: TimerFired[] = [];
      scheduler.onFire(f => fired.push(f));

      const past = new Date(Date.now() - 5000);
      for (let i = 0; i < 50; i++) {
        await scheduler.schedule(`burst-${i}`, past);
      }
      scheduler.start();
      await new Promise((r) => setTimeout(r, 80));

      assert.strictEqual(fired.length, 50, 'all 50 stale timers fire');
      const ids = new Set(fired.map((f) => f.instanceId));
      assert.strictEqual(ids.size, 50, 'each timer fired exactly once');
      assert.strictEqual(scheduler.timerCount, 0, 'no leaks');
      scheduler.stop();
    });
  });
});
