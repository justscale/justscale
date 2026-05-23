/**
 * Regression tests for two HIGH-severity executor bugs.
 *
 * rt-2: resubscribeSuspended() only handled race branches; plain-signal
 *       suspensions (await signal(x)) were silently orphaned after executor restart.
 *
 * proc-1: executor.ts trace log used JSON.stringify(result[1]) without a
 *         BigInt-safe replacer, causing a TypeError crash when a process
 *         returned an object containing BigInt values.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ProcessExecutor, generateInstanceId } from '../../../src/runtime/process/executor.js';
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
import { DONE, SUSPEND } from '../../../src/process/types.js';

import {
  awaitTick,
  EdgeSignals,
} from '../fixtures/runtime-edge-cases.process.js';

type Compiled<T> = { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>, T> };

function compiled<T>(def: unknown): CompiledSwitchProcess<Record<string, ServiceToken>, T> {
  return (def as Compiled<T>).__compiled;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// ============================================================================
// rt-2: plain-signal suspension survives executor restart
// ============================================================================

describe('rt-2: plain-signal suspension survives executor restart', () => {
  let storage: InMemoryProcessStorageInstance;
  let signalBus: InMemorySignalBus;
  let timerScheduler: InMemoryTimerScheduler;
  let serviceMap: Map<unknown, unknown>;

  const resolver: Resolver = (async (token: unknown) => serviceMap.get(token)) as Resolver;

  function buildExecutor(): ProcessExecutor {
    const executor = new ProcessExecutor({
      resolve: resolver,
      storage,
      signalBus,
      timerScheduler,
    });

    serviceMap.set(EdgeSignals, {
      tick: executor.createSignal<[id: string], { n: number }>('edge.tick', ['id']),
      kill: executor.createSignal<[id: string], { reason: string }>('edge.kill', ['id']),
      ping: executor.createSignal<[id: string]>('edge.ping', ['id']),
      pair: executor.createSignal<[a: string, b: string], { who: string }>('edge.pair', ['a', 'b']),
    });

    return executor;
  }

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
    signalBus = new InMemorySignalBus();
    timerScheduler = new InMemoryTimerScheduler();
    serviceMap = new Map();
  });

  afterEach(() => {
    setProcessExecutor(null);
    timerScheduler.stop();
    timerScheduler.clear();
    signalBus.clear();
    storage.clear();
  });

  it('wakes a plain-signal suspension after executor restart', async () => {
    // --- first executor: start and suspend ---
    const executor1 = buildExecutor();
    setProcessExecutor(executor1);
    executor1.register(compiled(awaitTick));

    const handle1 = await executor1.start(compiled(awaitTick), ['restart-test']);
    await tick();

    const suspended = await storage.load('edge/await-tick/restart-test');
    assert.equal(suspended?.status, 'suspended', 'process must be suspended after start');

    // Verify signal name was persisted
    assert.equal(
      suspended?.variables.__suspendSignal,
      'edge.tick',
      '__suspendSignal must be persisted in state.vars so restart can resubscribe',
    );

    // Simulate executor restart: the old in-memory subscriptions are gone.
    // signalBus.clear() wipes subscriptions — simulating the gap a pod restart causes.
    signalBus.clear();
    assert.equal(signalBus.subscriptionCount, 0, 'subscriptions cleared (simulates pod restart)');

    // --- second executor: re-hydrate against same storage + signal bus ---
    const executor2 = buildExecutor();
    setProcessExecutor(executor2);
    executor2.register(compiled(awaitTick));

    // start() on an already-suspended process must call resubscribeSuspended
    const handle2 = await executor2.start(compiled(awaitTick), ['restart-test']);
    await tick();

    assert.equal(
      signalBus.subscriptionCount,
      1,
      'executor2 must have re-subscribed after loading suspended state',
    );

    // Emit the signal through executor2 — the resurrected process must wake
    await executor2.emit('edge.tick', { id: 'restart-test' }, { n: 99 });
    await tick();

    const result = await Promise.race([
      handle2.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout: process did not wake after signal')), 2000),
      ),
    ]);

    assert.deepEqual(result, { id: 'restart-test', n: 99 });
  });
});

// ============================================================================
// proc-1: BigInt in process result does not crash trace log
// ============================================================================

describe('proc-1: BigInt in process result does not crash trace log', () => {
  let storage: InMemoryProcessStorageInstance;
  let signalBus: InMemorySignalBus;
  let timerScheduler: InMemoryTimerScheduler;

  const resolver: Resolver = (async () => undefined) as Resolver;

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
    signalBus = new InMemorySignalBus();
    timerScheduler = new InMemoryTimerScheduler();
  });

  afterEach(() => {
    timerScheduler.stop();
    timerScheduler.clear();
    signalBus.clear();
    storage.clear();
  });

  it('does not throw when a process returns an object containing BigInt', async () => {
    const bigintProcess: CompiledSwitchProcess<Record<string, ServiceToken>> = {
      id: 'bigint-test',
      path: '/bigint/:id',
      version: '1.0.0',
      inject: {},
      stepMap: { entry: 0 },
      sourceMap: {},
      signals: {},
      execute: async () => [DONE, { balance: 123n, label: 'test' }],
    };

    const executor = new ProcessExecutor({
      resolve: resolver,
      storage,
      signalBus,
      timerScheduler,
    });

    executor.register(bigintProcess);

    // Must not throw — before the fix this crashed with:
    //   TypeError: Do not know how to serialize a BigInt
    const handle = await executor.start(bigintProcess, ['b1']);
    await tick();

    const state = await storage.load('bigint/b1');
    assert.equal(state?.status, 'completed', 'process must complete without crashing on BigInt result');
  });
});
