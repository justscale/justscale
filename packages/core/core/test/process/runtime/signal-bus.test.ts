import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { InMemorySignalBus, type SignalMatch } from '../../../src/runtime/process/signal-bus.js';

describe('InMemorySignalBus', () => {
  let bus: InMemorySignalBus;

  beforeEach(() => {
    bus = new InMemorySignalBus();
  });

  describe('subscribe()', () => {
    it('returns a unique subscription ID', async () => {
      const id1 = await bus.subscribe('instance-1', 'orders.complete', { orderId: '123' });
      const id2 = await bus.subscribe('instance-2', 'orders.complete', { orderId: '456' });

      assert.ok(id1);
      assert.ok(id2);
      assert.notStrictEqual(id1, id2);
    });

    it('increments subscription count', async () => {
      assert.strictEqual(bus.subscriptionCount, 0);

      await bus.subscribe('instance-1', 'orders.complete', { orderId: '123' });
      assert.strictEqual(bus.subscriptionCount, 1);

      await bus.subscribe('instance-2', 'orders.complete', { orderId: '456' });
      assert.strictEqual(bus.subscriptionCount, 2);
    });
  });

  describe('emit()', () => {
    it('matches a waiting subscription', async () => {
      await bus.subscribe('instance-1', 'orders.complete', { orderId: '123' });

      const matchCount = await bus.emit('orders.complete', { orderId: '123' }, { status: 'paid' });

      assert.strictEqual(matchCount, 1);
    });

    it('returns 0 when no subscriptions match', async () => {
      await bus.subscribe('instance-1', 'orders.complete', { orderId: '123' });

      const matchCount = await bus.emit('orders.complete', { orderId: '999' });

      assert.strictEqual(matchCount, 0);
    });

    it('matches only subscriptions with correct signal name', async () => {
      await bus.subscribe('instance-1', 'orders.complete', { orderId: '123' });
      await bus.subscribe('instance-2', 'orders.shipped', { orderId: '123' });

      const matchCount = await bus.emit('orders.complete', { orderId: '123' });

      assert.strictEqual(matchCount, 1);
    });

    it('matches multiple subscriptions', async () => {
      await bus.subscribe('instance-1', 'broadcast.message', {});
      await bus.subscribe('instance-2', 'broadcast.message', {});
      await bus.subscribe('instance-3', 'broadcast.message', {});

      const matchCount = await bus.emit('broadcast.message', {}, 'hello');

      assert.strictEqual(matchCount, 3);
    });

    it('removes matched subscriptions', async () => {
      await bus.subscribe('instance-1', 'orders.complete', { orderId: '123' });

      await bus.emit('orders.complete', { orderId: '123' });

      assert.strictEqual(bus.subscriptionCount, 0);
    });

    it('stores the match for later retrieval', async () => {
      const subId = await bus.subscribe('instance-1', 'orders.complete', { orderId: '123' });

      await bus.emit('orders.complete', { orderId: '123' }, { amount: 100 });

      const match = await bus.checkSignal(subId);
      assert.ok(match);
      assert.strictEqual(match.instanceId, 'instance-1');
      assert.deepStrictEqual(match.payload, { amount: 100 });
    });

    it('matches partial identity (subscription is subset)', async () => {
      await bus.subscribe('instance-1', 'orders.complete', { orderId: '123' });

      // Emit with more identity params than the subscription requires
      const matchCount = await bus.emit('orders.complete', { orderId: '123', extra: 'ignored' });

      assert.strictEqual(matchCount, 1);
    });
  });

  describe('subscribeRace()', () => {
    it('returns a unique subscription ID', async () => {
      const id = await bus.subscribeRace('instance-1', [
        { branchId: 'branch-1', signal: 'orders.complete', identity: { orderId: '123' } },
        { branchId: 'branch-2', signal: 'orders.cancelled' },
      ]);

      assert.ok(id);
      assert.strictEqual(bus.raceCount, 1);
    });

    it('matches first matching branch on emit', async () => {
      const subId = await bus.subscribeRace('instance-1', [
        { branchId: 'complete', signal: 'orders.complete', identity: { orderId: '123' } },
        { branchId: 'cancelled', signal: 'orders.cancelled', identity: { orderId: '123' } },
      ]);

      await bus.emit('orders.complete', { orderId: '123' }, { status: 'paid' });

      const match = await bus.checkRace(subId);
      assert.ok(match);
      assert.strictEqual(match.branchId, 'complete');
      assert.deepStrictEqual(match.payload, { status: 'paid' });
    });

    it('only one branch wins', async () => {
      await bus.subscribeRace('instance-1', [
        { branchId: 'branch-1', signal: 'signal-a' },
        { branchId: 'branch-2', signal: 'signal-b' },
      ]);

      // Emit signal-a
      const count1 = await bus.emit('signal-a', {});
      assert.strictEqual(count1, 1);

      // Race is already resolved, signal-b should not match
      const count2 = await bus.emit('signal-b', {});
      assert.strictEqual(count2, 0);
    });

    // Sequential coverage above is fine, but the dangerous case is CONCURRENT:
    // two emits hitting different branches at once. The race-once contract
    // demands exactly ONE branch wins; if both ran, the process would receive
    // both branch payloads and break the `switch (true) { case ... }` shape.
    it('only one branch wins under CONCURRENT dual-branch emit', async () => {
      const subId = await bus.subscribeRace('instance-1', [
        { branchId: 'branch-a', signal: 'go-a' },
        { branchId: 'branch-b', signal: 'go-b' },
      ]);

      // Truly concurrent — Promise.all kicks off both emits before
      // either's microtasks run.
      const [countA, countB] = await Promise.all([
        bus.emit('go-a', {}),
        bus.emit('go-b', {}),
      ]);

      // Exactly one should report 1 match; the other 0.
      const total = countA + countB;
      assert.strictEqual(total, 1, `exactly one emit should match the race; got a=${countA}, b=${countB}`);

      // The stored match should be one of the two branches, not both.
      const match = await bus.checkRace(subId);
      assert.ok(match, 'race should have a match');
      assert.ok(
        match!.branchId === 'branch-a' || match!.branchId === 'branch-b',
        `match must be one of the two branches, got ${match!.branchId}`,
      );
    });

    it('subsequent matching emits do not re-trigger a consumed race', async () => {
      // After a race is consumed, ANY future emit on a matching branch
      // (concurrent or not) must report 0 matches.
      await bus.subscribeRace('instance-2', [
        { branchId: 'one', signal: 'x' },
        { branchId: 'two', signal: 'y' },
      ]);
      await bus.emit('x', {}); // consumes
      // Many concurrent re-emits on both branches — all must be no-ops.
      const counts = await Promise.all([
        bus.emit('x', {}),
        bus.emit('y', {}),
        bus.emit('x', {}),
        bus.emit('y', {}),
      ]);
      assert.deepStrictEqual(counts, [0, 0, 0, 0]);
    });
  });

  describe('unsubscribe()', () => {
    it('removes a subscription', async () => {
      const subId = await bus.subscribe('instance-1', 'orders.complete', { orderId: '123' });

      await bus.unsubscribe(subId);

      assert.strictEqual(bus.subscriptionCount, 0);
    });

    it('handles non-existent subscription gracefully', async () => {
      // Should not throw
      await bus.unsubscribe('non-existent-id');
    });
  });

  describe('onMatch()', () => {
    it('calls callback when signal is matched', async () => {
      const matches: SignalMatch[] = [];
      bus.onMatch(match => { matches.push(match); });

      await bus.subscribe('instance-1', 'orders.complete', { orderId: '123' });
      await bus.emit('orders.complete', { orderId: '123' }, 'payload');

      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].instanceId, 'instance-1');
      assert.strictEqual(matches[0].payload, 'payload');
    });

    it('returns unsubscribe function', async () => {
      const matches: SignalMatch[] = [];
      const unsub = bus.onMatch(match => { matches.push(match); });

      await bus.subscribe('instance-1', 'signal-a', {});
      await bus.emit('signal-a', {});

      assert.strictEqual(matches.length, 1);

      unsub(); // Unsubscribe

      await bus.subscribe('instance-2', 'signal-b', {});
      await bus.emit('signal-b', {});

      // Should still be 1, callback was removed
      assert.strictEqual(matches.length, 1);
    });

    it('handles callback errors gracefully', async () => {
      bus.onMatch(() => {
        throw new Error('Callback error');
      });

      await bus.subscribe('instance-1', 'test', {});

      // Should not throw
      await bus.emit('test', {});
    });
  });

  describe('checkExpiredTimers()', () => {
    it('matches race branches with expired timers', async () => {
      const past = new Date(Date.now() - 60000);
      const future = new Date(Date.now() + 60000);

      const subId = await bus.subscribeRace('instance-1', [
        { branchId: 'signal', signal: 'orders.complete' },
        { branchId: 'timeout', expiresAt: past },
      ]);

      const expired = await bus.checkExpiredTimers(new Date());

      assert.strictEqual(expired.length, 1);
      assert.strictEqual(expired[0].branchId, 'timeout');
      assert.strictEqual(expired[0].instanceId, 'instance-1');

      // Race should be resolved now
      assert.strictEqual(bus.raceCount, 0);
    });

    it('does not match timers that have not expired', async () => {
      const future = new Date(Date.now() + 60000);

      await bus.subscribeRace('instance-1', [
        { branchId: 'signal', signal: 'orders.complete' },
        { branchId: 'timeout', expiresAt: future },
      ]);

      const expired = await bus.checkExpiredTimers(new Date());

      assert.strictEqual(expired.length, 0);
      assert.strictEqual(bus.raceCount, 1); // Race still active
    });
  });

  describe('clear()', () => {
    it('removes all state', async () => {
      await bus.subscribe('instance-1', 'signal-a', {});
      await bus.subscribeRace('instance-2', [{ branchId: 'b', signal: 'signal-b' }]);

      bus.clear();

      assert.strictEqual(bus.subscriptionCount, 0);
      assert.strictEqual(bus.raceCount, 0);
      assert.strictEqual(bus.matchCount, 0);
    });
  });

  // --------------------------------------------------------------------------
  // Live-map-iteration hazard
  //
  // emit() used to iterate `this.subscriptions` directly. A process resumed
  // by notifyMatch can re-subscribe to the same signal before the outer
  // for-loop advances - the iterator then yields the new subscription
  // inside the SAME emit() call and delivers the payload a second time.
  // --------------------------------------------------------------------------

  describe('re-subscription during emit', () => {
    it('does not deliver a payload to a subscription created while emit() is still iterating', async () => {
      const matches: SignalMatch[] = [];
      bus.onMatch(async m => {
        matches.push(m);
        // Simulate the process waking up and immediately re-subscribing
        // (as it would after `await signal(x); await signal(x)`).
        await bus.subscribe(m.instanceId, 'tick', { id: 'A' });
      });

      await bus.subscribe('instance-A', 'tick', { id: 'A' });

      const matchCount = await bus.emit('tick', { id: 'A' }, { seq: 1 });

      assert.strictEqual(
        matchCount,
        1,
        'One emit() must match exactly one subscription, even if the ' +
        'match-callback creates a new subscription for the same signal.',
      );
      assert.strictEqual(
        matches.length,
        1,
        'notifyMatch must fire exactly once per emit() per subscription.',
      );
      // The re-subscription is still waiting for the NEXT emit.
      assert.strictEqual(bus.subscriptionCount, 1);
    });

    it('skips subscriptions cancelled mid-iteration', async () => {
      const matches: SignalMatch[] = [];
      const s1 = await bus.subscribe('instance-1', 'evt', {});
      const s2 = await bus.subscribe('instance-2', 'evt', {});

      bus.onMatch(async m => {
        matches.push(m);
        // First match cancels the second subscriber before the loop visits it.
        if (m.subscriptionId === s1) {
          await bus.unsubscribe(s2);
        }
      });

      const matchCount = await bus.emit('evt', {});

      assert.strictEqual(matchCount, 1, 's2 must not be delivered after unsubscribe');
      assert.strictEqual(matches.length, 1);
    });
  });
});
