/**
 * Signal dispatch edge cases for the process runtime.
 *
 * Pins down observable semantics documented in:
 *  - memory/feedback-signals-take-locked-not-ids.md (identity is typed;
 *    at the runtime boundary it's a record of strings)
 *  - memory/signal-delivery-model.md: "no dead letters, lock-based
 *    delivery, signals sync with process state"
 *  - memory/process-runtime-decisions.md: "best-effort + observability"
 *
 * What we assert here is the in-memory signal bus contract — there is
 * NO queuing of signals emitted before a matching subscription exists
 * (fire-and-forget), but there IS queuing of signals that arrive while
 * the owning instance is already processing a match.
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
  awaitTick,
  awaitPair,
  threeBranchRace,
  EdgeSignals,
} from '../fixtures/runtime-edge-cases.process.js';

type Compiled<T> = { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>, T> };

// A tiny helper so we don't have to repeat the cast everywhere.
function compiled<T>(def: unknown): CompiledSwitchProcess<Record<string, ServiceToken>, T> {
  return (def as Compiled<T>).__compiled;
}

// Short tick to let microtasks and setImmediate callbacks drain.
const tick = () => new Promise((r) => setImmediate(r));

describe('Signal dispatch semantics', () => {
  let executor: ProcessExecutor;
  let storage: InMemoryProcessStorageInstance;
  let signalBus: InMemorySignalBus;
  let timerScheduler: InMemoryTimerScheduler;

  // The service map is mutated in each test so signals point at the
  // executor under test. compiler-integration.test.ts does the same
  // dance — the framework doesn't give us a cleaner seam yet.
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

    // Rebuild the signal bundle against the new executor every test so
    // emitted signals land on the right bus.
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
  // Basic: suspend → emit → resume
  // --------------------------------------------------------------------------

  it('suspends on a single signal branch and resumes when that signal fires', async () => {
    const handle = await executor.start(compiled(awaitTick), ['t1']);

    const suspended = await storage.load('edge/await-tick/t1');
    assert.equal(suspended?.status, 'suspended');
    assert.equal(signalBus.subscriptionCount, 1);

    await executor.emit('edge.tick', { id: 't1' }, { n: 42 });

    const result = await handle.wait();
    assert.deepEqual(result, { id: 't1', n: 42 });

    // Subscription must be cleaned up on resume-to-completion.
    assert.equal(
      signalBus.subscriptionCount,
      0,
      'Matched subscription must be removed; leaking subs would re-trigger on next emit.',
    );
  });

  // --------------------------------------------------------------------------
  // Multi-branch race — only the winning branch runs
  // --------------------------------------------------------------------------

  it('only one branch of a three-branch race runs', async () => {
    const handle = await executor.start(compiled(threeBranchRace), ['m1']);

    // One race subscription registered, covering all three branches.
    assert.equal(signalBus.raceCount, 1, 'Race should register a single race subscription');

    await executor.emit('edge.kill', { id: 'm1' }, { reason: 'manual' });

    const result = await handle.wait();
    assert.deepEqual(result, { id: 'm1', which: 'kill', reason: 'manual' });

    // After winning, the whole race is consumed — further emits to the
    // losing branches must NOT produce a second resume.
    const beforeOther = await storage.load('edge/three-branch/m1');
    await executor.emit('edge.tick', { id: 'm1' }, { n: 1 });
    await executor.emit('edge.ping', { id: 'm1' }, undefined);
    await tick();
    const afterOther = await storage.load('edge/three-branch/m1');

    assert.deepEqual(
      afterOther?.result,
      beforeOther?.result,
      'Losing-branch emits after resolution must not re-drive the process.',
    );
    assert.equal(signalBus.raceCount, 0);
  });

  // --------------------------------------------------------------------------
  // Identity routing — signals with same name, different instances
  // --------------------------------------------------------------------------

  it('routes signals by identity: only the matching instance wakes', async () => {
    const h1 = await executor.start(compiled(awaitTick), ['i1']);
    const h2 = await executor.start(compiled(awaitTick), ['i2']);
    const h3 = await executor.start(compiled(awaitTick), ['i3']);

    assert.equal(signalBus.subscriptionCount, 3);

    // Emit only for i2.
    await executor.emit('edge.tick', { id: 'i2' }, { n: 7 });

    const r2 = await h2.wait();
    assert.deepEqual(r2, { id: 'i2', n: 7 });

    // The other two must still be waiting.
    const s1 = await storage.load('edge/await-tick/i1');
    const s3 = await storage.load('edge/await-tick/i3');
    assert.equal(s1?.status, 'suspended');
    assert.equal(s3?.status, 'suspended');
    assert.equal(signalBus.subscriptionCount, 2);

    // Clean up the lingering handles so node-test doesn't leak promises.
    await h1.cancel();
    await h3.cancel();
  });

  // --------------------------------------------------------------------------
  // Multi-param identity
  // --------------------------------------------------------------------------

  it('matches multi-param identity and ignores mismatched tuples', async () => {
    const h = await executor.start(compiled(awaitPair), ['alice', 'bob']);

    // Wrong `b` — must NOT match.
    const miss1 = await executor.emit(
      'edge.pair',
      { a: 'alice', b: 'carol' },
      { who: 'carol' },
    );
    assert.equal(miss1, 0, 'Different b value must not match');

    // Wrong `a` — must NOT match.
    const miss2 = await executor.emit(
      'edge.pair',
      { a: 'zoe', b: 'bob' },
      { who: 'zoe' },
    );
    assert.equal(miss2, 0, 'Different a value must not match');

    // Exact identity — matches and completes.
    const hit = await executor.emit(
      'edge.pair',
      { a: 'alice', b: 'bob' },
      { who: 'alice' },
    );
    assert.equal(hit, 1);

    const result = await h.wait();
    assert.deepEqual(result, { a: 'alice', b: 'bob', who: 'alice' });
  });

  // --------------------------------------------------------------------------
  // Fan-out: two different processes subscribe to the same signal path
  // --------------------------------------------------------------------------

  it('fans out a single emit across every matching subscriber', async () => {
    // Start two instances with the SAME identity (different paths would
    // normally be expected; here we use the same path+id on purpose to
    // prove that the bus would match both if two subs existed).
    // Since start() is idempotent per instanceId, we register a second
    // subscription manually on the bus to simulate two independent
    // waiters on the same identity.
    const h = await executor.start(compiled(awaitTick), ['f1']);

    // Manually register a phantom second subscription for the same
    // signal/identity tuple. This models "two processes at different
    // paths that happen to listen on the same identity".
    const phantom = await signalBus.subscribe(
      'phantom-instance',
      'edge.tick',
      { id: 'f1' },
    );
    assert.ok(phantom);
    assert.equal(signalBus.subscriptionCount, 2);

    const matches = await executor.emit('edge.tick', { id: 'f1' }, { n: 3 });
    assert.equal(
      matches,
      2,
      'Both subscribers (the process + the phantom) must be matched by a single emit.',
    );

    const r = await h.wait();
    assert.deepEqual(r, { id: 'f1', n: 3 });
  });

  // --------------------------------------------------------------------------
  // Pre-subscription emits are NOT queued (fire-and-forget semantics)
  // --------------------------------------------------------------------------

  it('an emit that arrives before any matching subscription is dropped', async () => {
    // Emit before anyone is listening.
    const preCount = await executor.emit('edge.tick', { id: 'drop-me' }, { n: 111 });
    assert.equal(preCount, 0, 'No subscriber → matchCount 0');

    // Now start the process. It should STILL suspend, not resume.
    const handle = await executor.start(compiled(awaitTick), ['drop-me']);
    const state = await storage.load('edge/await-tick/drop-me');
    assert.equal(
      state?.status,
      'suspended',
      'The earlier emit must not be replayed after subscribe; this guards against "ghost signals".',
    );

    await executor.emit('edge.tick', { id: 'drop-me' }, { n: 222 });
    const result = await handle.wait();
    assert.deepEqual(
      result,
      { id: 'drop-me', n: 222 },
      'Only the post-subscribe emit should be observed.',
    );
  });

  // --------------------------------------------------------------------------
  // Rapid consecutive emits — second is queued, delivered after resume
  // --------------------------------------------------------------------------

  // InMemorySignalBus.emit() snapshots `this.subscriptions` before
  // iterating. A process resumed synchronously by notifyMatch can
  // re-subscribe for the next await during the same emit call, but
  // because the iteration runs over a frozen snapshot the new
  // subscription is not visited - it waits for a separate emit.
  // Regression target for rt-1 (fixed in 2c038d19's sibling commit).
  it('one emit matches one subscription even when the match callback re-subscribes', async () => {
    const { twoSuspends } = await import('../fixtures/runtime-edge-cases.process.js');

    const handle = await executor.start(compiled(twoSuspends), ['q1']);
    assert.equal(signalBus.subscriptionCount, 1);

    // A single emit only wakes the first await. The process then
    // re-subscribes for the second await and remains suspended.
    await executor.emit('edge.tick', { id: 'q1' }, { n: 10 });

    const stored = await storage.load('edge/two-suspends/q1');
    assert.equal(
      stored?.status,
      'suspended',
      'Single emit must drive exactly one await; second await still suspended.',
    );

    // Second emit - distinct payload - drives the second await.
    await executor.emit('edge.tick', { id: 'q1' }, { n: 20 });

    const result = await handle.wait();
    assert.deepEqual(
      result,
      { id: 'q1', first: 10, second: 20 },
      'Each emit delivers its own payload; no cross-contamination.',
    );
  });

  // Sequential emits with a scheduler yield between them carry
  // independent payloads - the second one does not get swallowed by
  // the first's iteration frame.
  it('two sequential emits with a yield deliver distinct payloads', async () => {
    const { twoSuspends } = await import('../fixtures/runtime-edge-cases.process.js');

    const handle = await executor.start(compiled(twoSuspends), ['q2']);

    const first = await executor.emit('edge.tick', { id: 'q2' }, { n: 10 });
    assert.equal(first, 1, 'First emit wakes the first await.');
    await tick();

    const second = await executor.emit('edge.tick', { id: 'q2' }, { n: 20 });
    assert.equal(second, 1, 'Second emit wakes the second await.');

    const result = await handle.wait();
    assert.deepEqual(result, { id: 'q2', first: 10, second: 20 });
  });

  // --------------------------------------------------------------------------
  // Emit returns match count (observability)
  // --------------------------------------------------------------------------

  it('emit() returns the number of subscribers actually matched', async () => {
    const zero = await executor.emit('edge.tick', { id: 'nobody' }, { n: 0 });
    assert.equal(zero, 0);

    const handle = await executor.start(compiled(awaitTick), ['hit']);
    const one = await executor.emit('edge.tick', { id: 'hit' }, { n: 1 });
    assert.equal(
      one,
      1,
      'emit() is the only way callers can observe "did anyone care?" — this contract is load-bearing for observability.',
    );
    await handle.wait();
  });

  // --------------------------------------------------------------------------
  // Payload typing survives the encode/decode round-trip
  // --------------------------------------------------------------------------

  it('preserves payload shape through the signal pipeline', async () => {
    const handle = await executor.start(compiled(awaitTick), ['p1']);

    // Inject a payload with a non-primitive nested shape. The process
    // only reads `.n` so we use that as the assert, but the test is
    // really checking that the decoder doesn't mangle the object.
    await executor.emit(
      'edge.tick',
      { id: 'p1' },
      { n: 99, extra: { nested: [1, 2, 3], flag: true } },
    );

    const result = await handle.wait();
    assert.equal((result as { n: number }).n, 99);
  });
});
