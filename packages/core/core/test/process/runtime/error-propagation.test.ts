/**
 * Error propagation through the process runtime.
 *
 * These tests verify that a thrown error from the compiled handler
 * is captured by the executor, the process is marked failed, the
 * error message persists in storage, and handle.wait() rejects.
 *
 * Relevant memories:
 *  - memory/signal-delivery-model.md: failed processes must not remain
 *    in the run queue — no dangling subscriptions
 *  - memory/process-runtime-decisions.md: observability first
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ProcessExecutor } from '../../../src/runtime/process/executor.js';
import {
  createInMemoryProcessStorage,
  type InMemoryProcessStorageInstance,
} from '../../../src/runtime/process/storage.js';
import { InMemorySignalBus } from '../../../src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../../src/runtime/process/timer-scheduler.js';
import {
  setProcessExecutor,
  type CompiledSwitchProcess,
} from '../../../src/process/index.js';
import type { ServiceToken, Resolver } from '../../../src/core/index.js';

import {
  throwsBeforeSuspend,
  throwsAfterSignal,
  EdgeSignals,
  EdgeCrashService,
} from '../fixtures/runtime-edge-cases.process.js';

function compiled<T>(def: unknown): CompiledSwitchProcess<Record<string, ServiceToken>, T> {
  return (def as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>, T> }).__compiled;
}

describe('Error propagation', () => {
  let executor: ProcessExecutor;
  let storage: InMemoryProcessStorageInstance;
  let signalBus: InMemorySignalBus;
  let timerScheduler: InMemoryTimerScheduler;
  let serviceMap: Map<unknown, unknown>;

  const resolver: Resolver = (async (token: unknown) =>
    serviceMap.get(token)) as Resolver;

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
    signalBus = new InMemorySignalBus();
    timerScheduler = new InMemoryTimerScheduler();
    serviceMap = new Map();

    executor = new ProcessExecutor({
      resolve: resolver,
      storage,
      signalBus,
      timerScheduler,
    });

    serviceMap.set(EdgeSignals, {
      tick: executor.createSignal<[id: string], { n: number }>(
        'edge.tick',
        ['id'],
      ),
      kill: executor.createSignal<[id: string], { reason: string }>(
        'edge.kill',
        ['id'],
      ),
      ping: executor.createSignal<[id: string]>(
        'edge.ping',
        ['id'],
      ),
      pair: executor.createSignal<[a: string, b: string], { who: string }>(
        'edge.pair',
        ['a', 'b'],
      ),
    });

    serviceMap.set(EdgeCrashService, {
      boomBeforeSuspend: async () => { throw new Error('boom-before-suspend'); },
      boomAfterSignal: async () => { throw new Error('boom-after-signal'); },
    });

    setProcessExecutor(executor);
  });

  afterEach(() => {
    setProcessExecutor(null);
    timerScheduler.stop();
    timerScheduler.clear();
    signalBus.clear();
    storage.clear();
  });

  // --------------------------------------------------------------------------
  // Synchronous throw before first suspension
  // --------------------------------------------------------------------------

  it('a throw before any suspension marks the process failed and captures the message', async () => {
    const handle = await executor.start(compiled(throwsBeforeSuspend), ['e1']);

    const state = await storage.load('edge/throws-before/e1');
    assert.equal(state?.status, 'failed');
    assert.match(state?.error ?? '', /boom-before-suspend/);

    // No dangling subscriptions/timers.
    assert.equal(signalBus.subscriptionCount, 0);
    assert.equal(signalBus.raceCount, 0);
    assert.equal(timerScheduler.pendingCount, 0);

    await assert.rejects(handle.wait(), /boom-before-suspend/);
  });

  // --------------------------------------------------------------------------
  // Throw AFTER resuming from a signal
  // --------------------------------------------------------------------------

  it('a throw after resume-from-signal fails the process and rejects wait()', async () => {
    const handle = await executor.start(compiled(throwsAfterSignal), ['e2']);

    // Suspended cleanly.
    const before = await storage.load('edge/throws-after/e2');
    assert.equal(before?.status, 'suspended');

    // Fire the signal. The handler will throw immediately after.
    await executor.emit('edge.tick', { id: 'e2' }, { n: 1 });

    const after = await storage.load('edge/throws-after/e2');
    assert.equal(after?.status, 'failed');
    assert.match(after?.error ?? '', /boom-after-signal/);

    // Subscriptions should be gone — a failed process must not be
    // re-driven by later emits.
    assert.equal(signalBus.subscriptionCount, 0);
    assert.equal(signalBus.raceCount, 0);

    await assert.rejects(handle.wait(), /boom-after-signal/);
  });

  // --------------------------------------------------------------------------
  // Multiple emits after failure are ignored
  // --------------------------------------------------------------------------

  it('further emits against a failed instance match zero subscribers', async () => {
    const handle = await executor.start(compiled(throwsAfterSignal), ['e3']);
    await executor.emit('edge.tick', { id: 'e3' }, { n: 1 });

    await assert.rejects(handle.wait(), /boom-after-signal/);

    const matched = await executor.emit('edge.tick', { id: 'e3' }, { n: 2 });
    assert.equal(
      matched,
      0,
      'Failed process must not leave behind dangling subscriptions for later emits to target.',
    );
  });

  // --------------------------------------------------------------------------
  // Error inside an `await service.x()` — simulated via a service
  // method that rejects. The error bubbles from the compiled handler
  // and fails the process identically to a direct throw.
  // --------------------------------------------------------------------------

  it('a rejection from an injected service inside the handler fails the process', async () => {
    // Build a bespoke compiled process that awaits an injected service
    // method which then throws. We do this by hand (not via the
    // compiler) because we're testing the executor's error path, not
    // the compiler's.
    const ServiceToken = 'ErroringService' as unknown as ServiceToken;
    serviceMap.set(ServiceToken, {
      explode: async () => {
        throw new Error('service-blew-up');
      },
    });

    const proc: CompiledSwitchProcess<Record<string, ServiceToken>> = {
      id: 'erroring',
      path: '/err/:id',
      version: '1.0.0',
      inject: { svc: ServiceToken },
      stepMap: { entry: 0 },
      sourceMap: {},
      signals: {},
      async execute(ctx) {
        const svc = ctx.services.svc as { explode: () => Promise<void> };
        await svc.explode();
        return [0, null];
      },
    };

    const handle = await executor.start(proc, ['svc1']);

    const state = await storage.load('err/svc1');
    assert.equal(state?.status, 'failed');
    assert.match(state?.error ?? '', /service-blew-up/);

    await assert.rejects(handle.wait(), /service-blew-up/);
  });

  // --------------------------------------------------------------------------
  // A non-Error thrown value
  // --------------------------------------------------------------------------

  it('throwing a non-Error value still marks the process failed', async () => {
    const proc: CompiledSwitchProcess<Record<string, ServiceToken>> = {
      id: 'throw-string',
      path: '/throw-string/:id',
      version: '1.0.0',
      inject: {},
      stepMap: { entry: 0 },
      sourceMap: {},
      signals: {},
      async execute() {
         
        throw 'just-a-string';
      },
    };

    const handle = await executor.start(proc, ['s1']);

    const state = await storage.load('throw-string/s1');
    assert.equal(state?.status, 'failed');
    // The error field may contain 'just-a-string' or a stringified
    // form. Just check it captured something.
    assert.ok(
      (state?.error ?? '').length > 0,
      'Executor must capture a message even when the handler throws a non-Error.',
    );

    await assert.rejects(handle.wait());
  });

  // --------------------------------------------------------------------------
  // handle.wait() remains rejected across multiple calls
  // --------------------------------------------------------------------------

  it('handle.wait() after failure always rejects with the same error on subsequent calls', async () => {
    const handle = await executor.start(compiled(throwsBeforeSuspend), ['ew1']);

    const e1 = await handle.wait().catch((e: Error) => e);
    const e2 = await handle.wait().catch((e: Error) => e);

    assert.ok(e1 instanceof Error);
    assert.ok(e2 instanceof Error);
    assert.equal(
      (e1 as Error).message,
      (e2 as Error).message,
      'A failed handle must always reject with the same error; the completion deferred must remain rejected across retries.',
    );
  });

  // --------------------------------------------------------------------------
  // The failure is visible via executor.queryByStatus('failed')
  // --------------------------------------------------------------------------

  it('a failed process appears in queryByStatus("failed")', async () => {
    const handle = await executor.start(compiled(throwsBeforeSuspend), ['ef1']);
    await handle.wait().catch(() => {/* swallow */});

    const failed = [];
    for await (const s of executor.queryByStatus('failed')) {
      failed.push(s);
    }

    assert.equal(failed.length, 1);
    assert.equal(failed[0].instanceId, 'edge/throws-before/ef1');
  });
});
