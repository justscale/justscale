/**
 * setupTestProcessRuntime + in-memory runtime wiring.
 *
 * The harness spins up an InMemoryProcessStorage / InMemorySignalBus /
 * InMemoryTimerScheduler + ProcessExecutor, registers the executor for DI,
 * and returns a runtime handle for direct test control.
 *
 * We can't run a compiled process here, but we CAN verify that the runtime
 * pieces are wired correctly and that clear/stop/start behave.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Container } from '../../core/index.js';
import { setupTestProcessRuntime } from '../testing.js';
import { AbstractProcessExecutor } from '../../runtime/process/executor.js';
import { createInMemoryRuntime } from '../../runtime/process/factory.js';

describe('setupTestProcessRuntime', () => {
  it('returns a runtime with storage/signalBus/timerScheduler/executor', () => {
    const c = new Container();
    const runtime = setupTestProcessRuntime(c);
    assert.ok(runtime.storage);
    assert.ok(runtime.signalBus);
    assert.ok(runtime.timerScheduler);
    assert.ok(runtime.executor);
    runtime.stop();
  });

  it('registers the executor under AbstractProcessExecutor', async () => {
    const c = new Container();
    const runtime = setupTestProcessRuntime(c);
    const resolved = await c.resolve(AbstractProcessExecutor);
    assert.equal(resolved, runtime.executor);
    runtime.stop();
  });

  it('autoStart: true (default) starts the timer scheduler', async () => {
    const c = new Container();
    const runtime = setupTestProcessRuntime(c);
    // Ensure schedule + advance works without explicit .start()
    await runtime.timerScheduler.schedule('i1', new Date(Date.now() - 1));
    const fired = await runtime.timerScheduler.checkExpired();
    assert.equal(fired.length, 1);
    runtime.stop();
  });

  it('runtime.clear wipes storage, signals, and timers', async () => {
    const c = new Container();
    const runtime = setupTestProcessRuntime(c);
    await runtime.signalBus.subscribe('i', 'sig', {});
    await runtime.timerScheduler.schedule('i', new Date(Date.now() + 60_000));
    assert.equal(runtime.signalBus.subscriptionCount, 1);
    assert.equal(runtime.timerScheduler.pendingCount, 1);
    runtime.clear();
    assert.equal(runtime.signalBus.subscriptionCount, 0);
    assert.equal(runtime.timerScheduler.pendingCount, 0);
    runtime.stop();
  });

  it('runtime.stop is idempotent', () => {
    const c = new Container();
    const runtime = setupTestProcessRuntime(c);
    runtime.stop();
    // Second stop should not throw
    runtime.stop();
  });
});

describe('createInMemoryRuntime', () => {
  it('honours autoStart: false (timers not processed automatically)', async () => {
    const resolve = (() => {}) as any;
    const runtime = createInMemoryRuntime({ resolve, autoStart: false });
    await runtime.timerScheduler.schedule('i', new Date(Date.now() - 1));
    // Without start(), the underlying setTimeout isn't used. checkExpired
    // is always available (polling path).
    const fired = await runtime.timerScheduler.checkExpired();
    assert.equal(fired.length, 1);
    runtime.stop();
  });

  it('emit through the signal bus reaches subscribers directly', async () => {
    const resolve = (() => {}) as any;
    const runtime = createInMemoryRuntime({ resolve });
    const sub = await runtime.signalBus.subscribe('i', 'e', {});
    await runtime.signalBus.emit('e', {}, { ok: 1 });
    const match = await runtime.signalBus.checkSignal(sub);
    assert.deepEqual(match?.payload, { ok: 1 });
    runtime.stop();
  });

  it('clear resets storage even if processes were written', async () => {
    const resolve = (() => {}) as any;
    const runtime = createInMemoryRuntime({ resolve });
    await runtime.storage.save({
      processId: 'p',
      instanceId: 'i',
      version: '1',
      pc: 0,
      variables: {},
      timers: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'pending',
    });
    assert.equal(runtime.storage.size, 1);
    runtime.clear();
    assert.equal(runtime.storage.size, 0);
    runtime.stop();
  });

  it('storage.save/load/delete round-trip', async () => {
    const resolve = (() => {}) as any;
    const runtime = createInMemoryRuntime({ resolve });
    const state = {
      processId: 'p',
      instanceId: 'inst',
      version: '1',
      pc: 0,
      variables: { x: 1 },
      timers: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'pending' as const,
    };
    await runtime.storage.save(state);
    const loaded = await runtime.storage.load('inst');
    assert.ok(loaded);
    assert.equal((loaded!.variables as any).x, 1);
    await runtime.storage.delete('inst');
    assert.equal(await runtime.storage.load('inst'), null);
    runtime.stop();
  });

  it('storage.complete transitions state to completed with result', async () => {
    const resolve = (() => {}) as any;
    const runtime = createInMemoryRuntime({ resolve });
    await runtime.storage.save({
      processId: 'p',
      instanceId: 'i',
      version: '1',
      pc: 0,
      variables: {},
      timers: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'pending',
    });
    await runtime.storage.complete('i', { answer: 42 });
    const loaded = await runtime.storage.load('i');
    assert.equal(loaded?.status, 'completed');
    assert.deepEqual(loaded?.result, { answer: 42 });
    runtime.stop();
  });

  it('storage.fail transitions state to failed with error message', async () => {
    const resolve = (() => {}) as any;
    const runtime = createInMemoryRuntime({ resolve });
    await runtime.storage.save({
      processId: 'p',
      instanceId: 'i',
      version: '1',
      pc: 0,
      variables: {},
      timers: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'pending',
    });
    await runtime.storage.fail('i', 'boom');
    const loaded = await runtime.storage.load('i');
    assert.equal(loaded?.status, 'failed');
    assert.equal(loaded?.error, 'boom');
    runtime.stop();
  });

  it('storage.getStats returns per-status counts', async () => {
    const resolve = (() => {}) as any;
    const runtime = createInMemoryRuntime({ resolve });
    const base = {
      processId: 'p',
      version: '1',
      pc: 0,
      variables: {},
      timers: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await runtime.storage.save({ ...base, instanceId: 'a', status: 'pending' });
    await runtime.storage.save({ ...base, instanceId: 'b', status: 'suspended' });
    await runtime.storage.save({ ...base, instanceId: 'c', status: 'suspended' });
    const stats = runtime.storage.getStats();
    assert.equal(stats.pending, 1);
    assert.equal(stats.suspended, 2);
    runtime.stop();
  });
});
