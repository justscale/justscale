/**
 * Regression: ProcessRuntimeService is an adapter, not a parallel runtime.
 *
 * Pre-fix it built its own `new InMemorySignalBus()` and `new InMemoryTimerScheduler()`
 * inside the factory, so a controller injecting `runtime: ProcessRuntimeService`
 * would silently route emit/timer-fire to a parallel bus that had no compiled-process
 * subscribers — signals + delays were lost in pg multi-instance apps the moment
 * anyone followed the docstring example.
 *
 * These tests pin the adapter contract: runtime.executor must be the same
 * instance bound to AbstractProcessExecutor, runtime.signalBus must be the
 * one bound to AbstractSignalBus, and emit/handleTimerFired must delegate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Container } from '../../core/index.js';
import { AbstractProcessExecutor } from '../../runtime/process/executor.js';
import { AbstractSignalBus } from '../../runtime/process/signal-bus.js';
import type { TimerFired } from '../../runtime/process/timer-scheduler.js';
import { ProcessRuntimeService } from '../cluster-plugin.js';

interface FakeExecutor {
  emit(signal: string, identity: Record<string, string>, payload?: unknown): Promise<number>
  receiveTimerFire(fired: TimerFired): void
  __emitCalls: Array<{ signal: string; identity: Record<string, string>; payload?: unknown }>
  __timerFires: TimerFired[]
}

function buildFakeExecutor(): FakeExecutor {
  const emitCalls: FakeExecutor['__emitCalls'] = [];
  const timerFires: TimerFired[] = [];
  return {
    emit: async (signal, identity, payload) => {
      emitCalls.push({ signal, identity, payload });
      return 1;
    },
    receiveTimerFire: (fired) => {
      timerFires.push(fired);
    },
    __emitCalls: emitCalls,
    __timerFires: timerFires,
  };
}

interface FakeSignalBus {
  __identity: 'fake-signal-bus'
}

describe('ProcessRuntimeService routing', () => {
  it('runtime.executor IS the instance bound to AbstractProcessExecutor', async () => {
    const container = new Container();
    const fakeExecutor = buildFakeExecutor();
    const fakeBus: FakeSignalBus = { __identity: 'fake-signal-bus' };
    container.registerInstance(AbstractProcessExecutor, fakeExecutor as never);
    container.registerInstance(AbstractSignalBus, fakeBus as never);

    const runtime = await container.resolve(ProcessRuntimeService);

    // Adapter contract: runtime.executor must point at the canonical executor,
    // not a parallel one. Identity check would fail under the old impl which
    // built its own ProcessExecutor inside the factory.
    assert.equal(runtime.executor, fakeExecutor as unknown);
    assert.equal(runtime.signalBus, fakeBus as unknown);
  });

  it('runtime.emit delegates to the bound executor.emit (so signals reach bound bus subscribers)', async () => {
    const container = new Container();
    const fakeExecutor = buildFakeExecutor();
    container.registerInstance(AbstractProcessExecutor, fakeExecutor as never);
    container.registerInstance(AbstractSignalBus, { __identity: 'fake-signal-bus' } as never);

    const runtime = await container.resolve(ProcessRuntimeService);
    await runtime.emit('orders.shipped', { orderId: 'o-1' }, { trackingNumber: 'ABC' });

    assert.equal(fakeExecutor.__emitCalls.length, 1);
    assert.deepEqual(fakeExecutor.__emitCalls[0], {
      signal: 'orders.shipped',
      identity: { orderId: 'o-1' },
      payload: { trackingNumber: 'ABC' },
    });
  });

  it('runtime.handleTimerFired delegates to the bound executor.receiveTimerFire', async () => {
    const container = new Container();
    const fakeExecutor = buildFakeExecutor();
    container.registerInstance(AbstractProcessExecutor, fakeExecutor as never);
    container.registerInstance(AbstractSignalBus, { __identity: 'fake-signal-bus' } as never);

    const runtime = await container.resolve(ProcessRuntimeService);
    const fired: TimerFired = { timerId: 't-1', instanceId: 'i-1' };
    runtime.handleTimerFired(fired);

    assert.equal(fakeExecutor.__timerFires.length, 1);
    assert.equal(fakeExecutor.__timerFires[0], fired);
  });
});
