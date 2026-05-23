/**
 * InMemorySignalBus - subscribe / emit / race / unsubscribe.
 *
 * The signal bus is the abstraction for routing signals between emitters
 * and suspended processes. The in-memory implementation backs tests and
 * single-instance dev.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { InMemorySignalBus } from '../../runtime/process/signal-bus.js';

describe('InMemorySignalBus - simple subscribe/emit', () => {
  let bus: InMemorySignalBus;

  beforeEach(() => {
    bus = new InMemorySignalBus();
  });

  it('emit with no subscribers matches 0', async () => {
    const count = await bus.emit('x.y', {});
    assert.equal(count, 0);
  });

  it('subscribe returns a unique subscription id', async () => {
    const a = await bus.subscribe('inst-1', 'x', {});
    const b = await bus.subscribe('inst-2', 'x', {});
    assert.notEqual(a, b);
  });

  it('emit matches an identity-less subscription by signal name', async () => {
    const sub = await bus.subscribe('inst-1', 'pay.done', {});
    const count = await bus.emit('pay.done', {});
    assert.equal(count, 1);
    assert.equal((await bus.checkSignal(sub))?.instanceId, 'inst-1');
  });

  it('emit with identity filter matches only matching subscriptions', async () => {
    const matched = await bus.subscribe('inst-a', 'order.done', { orderId: '1' });
    const mismatched = await bus.subscribe('inst-b', 'order.done', { orderId: '2' });
    const count = await bus.emit('order.done', { orderId: '1' });
    assert.equal(count, 1);
    assert.ok(await bus.checkSignal(matched));
    assert.equal(await bus.checkSignal(mismatched), null);
  });

  it('subscription is removed after a successful match', async () => {
    await bus.subscribe('i', 'e', {});
    await bus.emit('e', {});
    // Second emit has no live subscribers
    const second = await bus.emit('e', {});
    assert.equal(second, 0);
  });

  it('emit delivers payload in checkSignal result', async () => {
    const sub = await bus.subscribe('i', 'e', {});
    await bus.emit('e', {}, { data: 'hello' });
    const match = await bus.checkSignal(sub);
    assert.deepEqual(match?.payload, { data: 'hello' });
  });

  it('emit without payload leaves payload undefined', async () => {
    const sub = await bus.subscribe('i', 'e', {});
    await bus.emit('e', {});
    const match = await bus.checkSignal(sub);
    assert.equal(match?.payload, undefined);
  });

  it('unsubscribe stops future deliveries', async () => {
    const sub = await bus.subscribe('i', 'e', {});
    await bus.unsubscribe(sub);
    const count = await bus.emit('e', {});
    assert.equal(count, 0);
    assert.equal(await bus.checkSignal(sub), null);
  });

  it('onMatch callback fires on successful match', async () => {
    const seen: unknown[] = [];
    const off = bus.onMatch((m) => {
      seen.push(m);
    });
    await bus.subscribe('i', 'e', {});
    await bus.emit('e', {}, { x: 1 });
    assert.equal(seen.length, 1);
    off();
  });

  it('onMatch returned unsubscribe works', async () => {
    const seen: unknown[] = [];
    const off = bus.onMatch((m) => {
      seen.push(m);
    });
    off();
    await bus.subscribe('i', 'e', {});
    await bus.emit('e', {});
    assert.equal(seen.length, 0);
  });

  it('identity with extra emit keys still matches subscription', async () => {
    // Subscription with { orderId: '1' } matches emit { orderId: '1', userId: '9' }
    const sub = await bus.subscribe('i', 'e', { orderId: '1' });
    const count = await bus.emit('e', { orderId: '1', userId: '9' });
    assert.equal(count, 1);
    assert.ok(await bus.checkSignal(sub));
  });

  it('identity where sub has a key emit does not is a mismatch', async () => {
    await bus.subscribe('i', 'e', { orderId: '1' });
    // emit identity missing orderId
    const count = await bus.emit('e', {});
    assert.equal(count, 0);
  });
});

describe('InMemorySignalBus - findSubscriptions', () => {
  let bus: InMemorySignalBus;

  beforeEach(() => {
    bus = new InMemorySignalBus();
  });

  it('returns empty when no match', async () => {
    const result = await bus.findSubscriptions('x', {});
    assert.deepEqual(result, []);
  });

  it('returns one entry per matching subscription', async () => {
    await bus.subscribe('i1', 'e', { a: '1' });
    await bus.subscribe('i2', 'e', { a: '1' });
    await bus.subscribe('i3', 'e', { a: '2' });
    const result = await bus.findSubscriptions('e', { a: '1' });
    assert.equal(result.length, 2);
    const ids = result.map((r) => r.instanceId).sort();
    assert.deepEqual(ids, ['i1', 'i2']);
  });

  it('returns race subscriptions too (one per race, not per branch)', async () => {
    await bus.subscribeRace('race-1', [
      { branchId: 'b1', signal: 'e', identity: { k: '1' } },
      { branchId: 'b2', signal: 'e', identity: { k: '1' } }, // same signal, same identity
    ]);
    const result = await bus.findSubscriptions('e', { k: '1' });
    assert.equal(result.length, 1);
    assert.equal(result[0].instanceId, 'race-1');
  });
});

describe('InMemorySignalBus - races', () => {
  let bus: InMemorySignalBus;

  beforeEach(() => {
    bus = new InMemorySignalBus();
  });

  it('subscribeRace with a single signal branch matches on emit', async () => {
    const sub = await bus.subscribeRace('inst', [
      { branchId: 'payment', signal: 'pay.ok', identity: { id: '1' } },
    ]);
    const count = await bus.emit('pay.ok', { id: '1' });
    assert.equal(count, 1);
    const match = await bus.checkRace(sub);
    assert.equal(match?.branchId, 'payment');
    assert.equal(match?.instanceId, 'inst');
  });

  it('race branch identity mismatch does not trigger the race', async () => {
    const sub = await bus.subscribeRace('inst', [
      { branchId: 'payment', signal: 'pay.ok', identity: { id: '1' } },
    ]);
    const count = await bus.emit('pay.ok', { id: '2' });
    assert.equal(count, 0);
    assert.equal(await bus.checkRace(sub), null);
  });

  it('first matching branch wins; others get no value', async () => {
    const sub = await bus.subscribeRace('inst', [
      { branchId: 'a', signal: 'sig.a', identity: {} },
      { branchId: 'b', signal: 'sig.b', identity: {} },
    ]);
    await bus.emit('sig.a', {});
    const match = await bus.checkRace(sub);
    assert.equal(match?.branchId, 'a');
    // After first match, race is consumed
    assert.equal(bus.raceCount, 0);
  });

  it('a second emit for the other branch does not change the winner', async () => {
    const sub = await bus.subscribeRace('inst', [
      { branchId: 'a', signal: 'sig.a', identity: {} },
      { branchId: 'b', signal: 'sig.b', identity: {} },
    ]);
    await bus.emit('sig.a', {});
    await bus.emit('sig.b', {});
    const match = await bus.checkRace(sub);
    assert.equal(match?.branchId, 'a');
  });

  it('unsubscribe race cancels it', async () => {
    const sub = await bus.subscribeRace('inst', [
      { branchId: 'a', signal: 'sig', identity: {} },
    ]);
    await bus.unsubscribe(sub);
    const count = await bus.emit('sig', {});
    assert.equal(count, 0);
  });

  it('checkExpiredTimers fires race timer branches that expired', async () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    const subExpired = await bus.subscribeRace('inst-1', [
      { branchId: 'timeout', expiresAt: past },
    ]);
    const subFuture = await bus.subscribeRace('inst-2', [
      { branchId: 'timeout', expiresAt: future },
    ]);
    const fired = await bus.checkExpiredTimers();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].branchId, 'timeout');
    // Expired race consumed; future still pending
    assert.ok(await bus.checkRace(subExpired));
    assert.equal(await bus.checkRace(subFuture), null);
  });

  it('raceCount reflects pending races', async () => {
    await bus.subscribeRace('a', [{ branchId: 'x', signal: 's', identity: {} }]);
    await bus.subscribeRace('b', [{ branchId: 'x', signal: 's', identity: {} }]);
    assert.equal(bus.raceCount, 2);
  });
});

describe('InMemorySignalBus - state cleanup', () => {
  it('clear resets all subscriptions/races/matches', async () => {
    const bus = new InMemorySignalBus();
    await bus.subscribe('i', 'e', {});
    await bus.subscribeRace('r', [{ branchId: 'b', signal: 's', identity: {} }]);
    bus.onMatch(() => {});
    bus.clear();
    assert.equal(bus.subscriptionCount, 0);
    assert.equal(bus.raceCount, 0);
    assert.equal(bus.matchCount, 0);
  });
});
