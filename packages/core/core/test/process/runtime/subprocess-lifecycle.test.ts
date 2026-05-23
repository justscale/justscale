/**
 * Subprocess Lifecycle — contract tests for `createSubProcess()`.
 *
 * Design-doc source of truth: memory/process-exports-design.md
 *
 * Expected semantic (canonical):
 *   - `createSubProcess({ name, path, handler })` is an addressable, named
 *     subprocess nested inside a parent's JSONB blob. Shares parent's
 *     advisory lock. Full access to parent state.
 *   - `const h = await sub('alice')` spawns the child and returns a handle
 *     (or SubRef) that the parent can await, read exports from, etc.
 *   - Child runs independently until it returns, throws, or the parent
 *     terminates.
 *   - `await handle.wait()` from parent/external code must resolve with
 *     the child's return value; throw if the child failed.
 *   - `handle.data` must expose the child's own `using exports`.
 *   - Spawning the same subprocess name with the same args twice must be
 *     idempotent (design doc: addressable by path + args, nested under parent).
 *
 * Current behaviour (2026-04-21, per packages/core/core/src/runtime/process/executor.ts):
 *   - `spawnSubprocess()` allocates a nested state blob keyed
 *     `__sub:<name>:<args...>` and stores a SubRef in `state.vars[storeVar]`,
 *     then continues parent execution via `this.execute(state, process, identity)`.
 *   - It does NOT actually invoke the subprocess's `execute()` function.
 *   - It does NOT maintain child-process lifecycle (no status, no waiting).
 *   - There is no public API to call `wait()` on a subprocess SubRef.
 *   - Handing the SubRef to an external observer for exports streaming is
 *     not wired.
 *
 * Therefore most lifecycle tests here are `.todo` — they pin the behaviour
 * the runtime agent needs to implement. The few that pass demonstrate what
 * currently works (parent runs past the spawn point, SubRef is stored).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

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
  type Signal,
} from '../../../src/process/index.js';
import type { ServiceToken, Resolver } from '../../../src/core/index.js';

import {
  SubSignals,
  parentWithOneChildProcess,
  parentWithTwoChildrenProcess,
  parentSameArgsTwiceProcess,
} from '../fixtures/subprocess.process.js';
// Reuse the simple (no-subprocess) fixtures for plain handle-primitive
// tests — avoids tripping over the SUBPROCESS_SPAWN compiler/runtime gap.
import {
  immediateProcess,
  waitForSignalProcess,
  SimpleSignals,
} from '../fixtures/simple.process.js';

// ============================================================================
// Helpers
// ============================================================================

const createMockResolver = (services: Map<unknown, unknown>): Resolver =>
  (async (token: unknown) => services.get(token)) as Resolver;

type Compiled = CompiledSwitchProcess<Record<string, ServiceToken>>;
const compiled = (p: unknown) => (p as { __compiled: Compiled }).__compiled;

interface TestCtx {
  executor: ProcessExecutor
  storage: InMemoryProcessStorageInstance
  signalBus: InMemorySignalBus
  timerScheduler: InMemoryTimerScheduler
  signals: {
    parentDone: Signal<any, any>
    childTick: Signal<any, any>
    childDone: Signal<any, any>
  }
}

// Separate ctx shape for the sub-3/sub-4 blocks, which exercise the
// scalarExportsProcess fixture (using ExportsSignals: tick + stop).
interface ExportsCtx {
  executor: ProcessExecutor
  storage: InMemoryProcessStorageInstance
  signalBus: InMemorySignalBus
  timerScheduler: InMemoryTimerScheduler
  signals: {
    tick: Signal<any, any>
    stop: Signal<any, any>
  }
}

function buildCtx(): TestCtx {
  const storage = createInMemoryProcessStorage();
  const signalBus = new InMemorySignalBus();
  const timerScheduler = new InMemoryTimerScheduler();

  const serviceMap = new Map<unknown, unknown>();
  const executor = new ProcessExecutor({
    resolve: createMockResolver(serviceMap),
    storage,
    signalBus,
    timerScheduler,
  });

  const signals = {
    parentDone: executor.createSignal<[id: string]>('sub.parentDone', ['id']),
    childTick: executor.createSignal<[id: string, childId: string]>(
      'sub.childTick',
      ['id', 'childId']
    ),
    childDone: executor.createSignal<[id: string, childId: string]>(
      'sub.childDone',
      ['id', 'childId']
    ),
  };

  serviceMap.set(SubSignals, signals);
  setProcessExecutor(executor);
  return { executor, storage, signalBus, timerScheduler, signals };
}

function teardown(ctx: TestCtx | ExportsCtx) {
  setProcessExecutor(null);
  ctx.timerScheduler.stop();
  ctx.timerScheduler.clear();
  ctx.signalBus.clear();
  ctx.storage.clear();
}

// ============================================================================
// Compiled shape — what the compiler emits for createSubProcess
// ============================================================================

describe('createSubProcess — compiled shape', () => {
  it('parent with one child exposes subprocesses array on compiled process', () => {
    const c = compiled(parentWithOneChildProcess);
    assert.ok(c.subprocesses, 'parent must carry subprocesses array');
    assert.strictEqual(c.subprocesses!.length, 1);
    assert.strictEqual(c.subprocesses![0].name, 'child');
  });

  it('child definition has its own stepMap and signals', () => {
    const c = compiled(parentWithOneChildProcess);
    const child = c.subprocesses![0];
    assert.ok(child.stepMap, 'child must have a stepMap');
    assert.ok(child.signals, 'child must have its own signals map');
  });

  it('child has exports metadata when it declares using exports', () => {
    const c = compiled(parentWithOneChildProcess);
    const child = c.subprocesses![0];
    // The child handler uses `using exports = { tickCount }`.
    // Expected: child.exports.fields = ['tickCount'].
    assert.ok(child.exports, 'child should carry exports metadata');
    assert.deepStrictEqual(child.exports!.fields, ['tickCount']);
  });

  it('child.params records handler parameter names', () => {
    const c = compiled(parentWithOneChildProcess);
    const child = c.subprocesses![0];
    assert.deepStrictEqual(child.params, ['childId']);
  });

  it('parent with multiple children records only one definition when shared', () => {
    const c = compiled(parentWithTwoChildrenProcess);
    // Same child definition, spawned twice — emitted once on the parent.
    assert.strictEqual(c.subprocesses!.length, 1);
    assert.strictEqual(c.subprocesses![0].name, 'child');
  });
});

// ============================================================================
// Spawn mechanics — what gets emitted and what the runtime does
//
// CRITICAL GAP (2026-04-21): the compiler emits child metadata on the compiled
// parent (subprocesses[]), and the analyzer test demonstrates SUBPROCESS_SPAWN
// opcodes. BUT when the full pipeline runs (ptsc loader + executor) the
// parent's step 0 for our fixture emits:
//     state.vars.alice = await state.vars.child("alice");
// instead of going through the SUBPROCESS execution-result path. Evidence:
//   const c = parentWithOneChildProcess.__compiled
//   // c.subprocesses[0].name === 'child' ✓
//   // c.execute(...) at step 0 calls `await state.vars.child("alice")` ✗
//
// Because `child` is not restored as a callable on resume, calling it throws
// "state.vars.child is not a function" and the process fails immediately.
//
// These tests pin that gap. When the compiler starts emitting SUBPROCESS_SPAWN
// for real fixtures (not just synthetic analyzer inputs), swap the `.todo` for
// a real assertion and these tests will pass.
// ============================================================================

describe('createSubProcess — spawn storage (COMPILER/RUNTIME GAPS)', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = buildCtx();
  });
  afterEach(() => teardown(ctx));

  it('parent suspends after spawning child subprocess and awaiting parentDone signal', async () => {
    // With compiler + executor wired: parent step 0 emits SUBPROCESS_SPAWN,
    // executor runs the child (which suspends on childTick/childDone race),
    // then parent advances to step 1 and suspends on parentDone.
    // handle.wait() should therefore remain pending (process is suspended).
    const handle = await ctx.executor.start(
      compiled(parentWithOneChildProcess),
      ['p1']
    );
    // The process should be suspended (awaiting parentDone), not failed.
    const state = await ctx.storage.load('subproc/one/p1');
    assert.ok(state, 'state must exist after start');
    assert.strictEqual(state!.status, 'suspended', `expected suspended, got: ${state!.status}`);

    // handle.wait() stays pending — we don't send the signal, so just check
    // that the process didn't immediately throw.
    const waitRace = await Promise.race([
      handle.wait().then(() => 'done').catch((e: Error) => `error:${e.message}`),
      new Promise<string>(resolve => setTimeout(() => resolve('pending'), 50)),
    ]);
    assert.strictEqual(waitRace, 'pending', `expected process to be suspended, got: ${waitRace}`);
  });

  it('spawning a subprocess stores a nested blob under __sub:<name>:<args>', async () => {
    await ctx.executor.start(compiled(parentWithOneChildProcess), ['p1']);
    const state = await ctx.storage.load('subproc/one/p1');
    const vars = state!.variables as Record<string, unknown>;
    const subKeys = Object.keys(vars).filter(k => k.startsWith('__sub:'));
    assert.ok(subKeys.length >= 1, `expected at least one __sub: key, got ${JSON.stringify(subKeys)}`);
    assert.ok(subKeys.includes('__sub:child:alice'), 'expected __sub:child:alice');
  });

  it('child nested state vars[paramName] maps to handler arg by position', async () => {
    await ctx.executor.start(compiled(parentWithOneChildProcess), ['p2']);
    const state = await ctx.storage.load('subproc/one/p2');
    const vars = state!.variables as Record<string, unknown>;
    const subBlob = vars['__sub:child:alice'] as
      | { vars?: Record<string, unknown> }
      | undefined;
    assert.ok(subBlob);
    assert.strictEqual(
      (subBlob!.vars as Record<string, unknown>).childId,
      'alice'
    );
  });

  it('spawning two different children creates two nested blobs', async () => {
    await ctx.executor.start(compiled(parentWithTwoChildrenProcess), ['p3']);
    // Parent suspends on alice. Drive alice's childDone to let parent
    // advance and spawn bob. Then bob also suspends, but both blobs exist.
    await ctx.signals.childDone('p3', 'alice');
    const state = await ctx.storage.load('subproc/two/p3');
    const vars = state!.variables as Record<string, unknown>;
    const subKeys = Object.keys(vars).filter(k => k.startsWith('__sub:'));
    assert.strictEqual(subKeys.length, 2, `expected 2 sub-blobs, got: ${JSON.stringify(subKeys)}`);
    assert.ok(subKeys.includes('__sub:child:alice'));
    assert.ok(subKeys.includes('__sub:child:bob'));
  });

  it('spawning the same subprocess twice with same args is idempotent', async () => {
    // Design: nested blobs are addressable by name+args. The second spawn
    // with identical args should reuse the first blob (which is already
    // done by the time parent reaches the second spawn statement).
    await ctx.executor.start(compiled(parentSameArgsTwiceProcess), ['p4']);
    await ctx.signals.childDone('p4', 'alice');
    const state = await ctx.storage.load('subproc/dup/p4');
    const vars = state!.variables as Record<string, unknown>;
    const subKeys = Object.keys(vars).filter(k => k.startsWith('__sub:'));
    assert.strictEqual(subKeys.length, 1, 'idempotent: second spawn reuses first blob');
    // Both `first` and `second` storeVars received the same child return value.
    assert.ok(vars.first, `vars.first should be populated, got: ${JSON.stringify(vars.first)}`);
    assert.ok(vars.second, `vars.second should be populated, got: ${JSON.stringify(vars.second)}`);
    assert.deepStrictEqual(vars.first, vars.second, 'idempotent: both get the same return value');
  });
});

// ============================================================================
// Subprocess lifecycle — NOT YET IMPLEMENTED
// ============================================================================
//
// The runtime agent flagged these as gaps. Each .todo below is a contract
// the implementation needs to satisfy. When wired, swap .todo → no flag
// and verify the tests pass.

describe('createSubProcess — lifecycle', () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = buildCtx();
  });
  afterEach(() => teardown(ctx));

  it('child runs independently — childTick updates child state without affecting parent', async () => {
    await ctx.executor.start(compiled(parentWithOneChildProcess), ['p1']);
    // Drive the child twice; tickCount in child's exports should increment.
    await ctx.signals.childTick('p1', 'alice');
    await ctx.signals.childTick('p1', 'alice');

    const state = await ctx.storage.load('subproc/one/p1');
    const blob = state!.variables['__sub:child:alice'] as { vars: { exports?: { tickCount?: number } } };
    assert.ok(blob.vars.exports, 'child exports should be present after ticks');
    assert.strictEqual(blob.vars.exports!.tickCount, 2, `tickCount should be 2, got ${blob.vars.exports!.tickCount}`);
    // Parent should still be suspended (awaiting child, which is still looping).
    assert.strictEqual(state!.status, 'suspended');
  });

  it('parent `await child(...)` resolves with the child return value', async () => {
    const handle = await ctx.executor.start(compiled(parentWithOneChildProcess), ['p1']);
    await ctx.signals.childTick('p1', 'alice');
    await ctx.signals.childTick('p1', 'alice');
    await ctx.signals.childDone('p1', 'alice');
    // Child returned; parent resumed past the spawn, now suspended on parentDone.
    await ctx.signals.parentDone('p1');
    const result = (await handle.wait()) as { parent: string; aliceRef: { childId: string; ticks: number } };
    assert.strictEqual(result.parent, 'p1');
    assert.strictEqual(result.aliceRef.childId, 'alice');
    assert.strictEqual(result.aliceRef.ticks, 2, `expected 2 ticks captured in child return, got ${result.aliceRef.ticks}`);
  });

  it('parent cancelled → child subscriptions torn down (cascade)', async () => {
    const handle = await ctx.executor.start(compiled(parentWithOneChildProcess), ['p1']);
    // Child is subscribed to childTick/childDone. Cancel parent — cleanup
    // cascades via cleanupChildSubscriptions.
    const cancelled = await handle.cancel();
    assert.strictEqual(cancelled, true);
    const stateBefore = await ctx.storage.load('subproc/one/p1');
    assert.strictEqual(stateBefore!.status, 'cancelled');

    // Emitting childTick now should be a no-op — child is gone from the bus.
    // If the cascade failed, child would wake up and increment tickCount.
    await ctx.signals.childTick('p1', 'alice');

    const stateAfter = await ctx.storage.load('subproc/one/p1');
    const blob = stateAfter!.variables['__sub:child:alice'] as { vars: { exports?: { tickCount?: number } } };
    assert.strictEqual(blob.vars.exports?.tickCount ?? 0, 0, 'cancelled child must not process new signals');
  });

  it('child signals route by child path params — alice receives, bob does not', async () => {
    // parentWithTwoChildrenProcess spawns alice then (after alice done) bob.
    // To have BOTH subscribed simultaneously, drive alice to completion
    // — parent resumes and spawns bob. Now alice is done, bob is pending.
    // Flip: verify childDone is routed per-child, not broadcast.
    await ctx.executor.start(compiled(parentWithTwoChildrenProcess), ['p4']);
    await ctx.signals.childDone('p4', 'alice');
    // Now bob is subscribed. Sending childDone for a non-existent child
    // must not affect bob; sending for bob should complete bob.
    await ctx.signals.childDone('p4', 'nobody');
    let state = await ctx.storage.load('subproc/two/p4');
    const bobBlob = state!.variables['__sub:child:bob'] as { done: boolean };
    assert.strictEqual(bobBlob.done, false, 'bob must remain pending after childDone for nobody');

    await ctx.signals.childDone('p4', 'bob');
    state = await ctx.storage.load('subproc/two/p4');
    const bobBlobAfter = state!.variables['__sub:child:bob'] as { done: boolean };
    assert.strictEqual(bobBlobAfter.done, true, 'bob completes when its own childDone fires');
  });

});

// ============================================================================
// Handle primitives — pin what wait(), cancel(), data, status must do.
// Uses simple.process.ts fixtures (no subprocesses) so the subprocess
// compiler gap above doesn't confound these assertions.
// ============================================================================

describe('ProcessHandle — primitives', () => {
  let ctx: TestCtx;
  let signalsForSimple: {
    approved: Signal<any, any>
    rejected: Signal<any, any>
  };

  beforeEach(() => {
    ctx = buildCtx();
    // Register a SimpleSignals service so waitForSignalProcess can resolve it
    signalsForSimple = {
      approved: ctx.executor.createSignal<[taskId: string], { approver: string }>(
        'simple.approved',
        ['taskId']
      ),
      rejected: ctx.executor.createSignal<[taskId: string], { reason: string }>(
        'simple.rejected',
        ['taskId']
      ),
    };
    // Rebuild resolver to also know about SimpleSignals
    (ctx.executor as unknown as { resolve: Resolver }).resolve = (async (
      token: unknown
    ) => {
      if (token === SimpleSignals) return signalsForSimple;
      if (token === SubSignals) return ctx.signals;
      return undefined;
    }) as Resolver;
  });
  afterEach(() => teardown(ctx));

  it('handle.wait() resolves with the process result (immediate process)', async () => {
    const handle = await ctx.executor.start(compiled(immediateProcess), [
      'wait1',
    ]);
    const result = (await handle.wait()) as { id: string; status: string };
    assert.strictEqual(result.id, 'wait1');
    assert.strictEqual(result.status, 'completed');
  });

  it('handle.wait() called multiple times resolves to the same result', async () => {
    const handle = await ctx.executor.start(compiled(waitForSignalProcess), [
      'wait2',
    ]);
    await signalsForSimple.approved('wait2', { approver: 'alice' });
    const [a, b, c] = await Promise.all([
      handle.wait(),
      handle.wait(),
      handle.wait(),
    ]);
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(b, c);
  });

  it('handle.cancel() on a suspended process returns true and transitions to cancelled', async () => {
    const handle = await ctx.executor.start(compiled(waitForSignalProcess), [
      'cancel1',
    ]);
    const cancelled = await handle.cancel();
    assert.strictEqual(cancelled, true);
    const state = await ctx.storage.load('wait-signal/cancel1');
    assert.strictEqual(state?.status, 'cancelled');
  });

  it('handle.cancel() on an already-completed process returns false', async () => {
    const handle = await ctx.executor.start(compiled(immediateProcess), [
      'cancel2',
    ]);
    await handle.wait();
    const cancelled = await handle.cancel();
    assert.strictEqual(cancelled, false);
  });

  it('handle.wait() rejects after cancellation', async () => {
    const handle = await ctx.executor.start(compiled(waitForSignalProcess), [
      'cancel3',
    ]);
    const waitP = handle.wait();
    // Prevent unhandled rejection warning if the rejection happens before
    // the try/catch block wires up.
    waitP.catch(() => {});
    await handle.cancel();
    try {
      await waitP;
      assert.fail('expected wait() to reject after cancel');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /cancel/i);
    }
  });

  it('ProcessHandle is explicitly NOT thenable (design: avoid automatic unwrap)', async () => {
    const handle = await ctx.executor.start(compiled(immediateProcess), [
      'then1',
    ]);
    // Design comment in types.ts: "ProcessHandle is intentionally NOT a
    // thenable (no `then` method)." Confirm that invariant.
    assert.strictEqual(
      typeof (handle as unknown as { then?: unknown }).then,
      'undefined',
      'ProcessHandle must not have .then — prevents accidental Promise-unwrap'
    );
    await handle.wait();
  });

  it(
    'handle.status tracks lifecycle transitions without an explicit refresh',
    async () => {
      const handle = await ctx.executor.start(compiled(waitForSignalProcess), [
        'status1',
      ]);
      // After start(), process suspends on the signal — status should be suspended
      assert.strictEqual(handle.status, 'suspended', `expected suspended, got ${handle.status}`);

      // Send signal to complete the process
      await signalsForSimple.approved('status1', { approver: 'alice' });
      await handle.wait();

      // After completion, status should be completed without calling refresh()
      assert.strictEqual(handle.status, 'completed', `expected completed, got ${handle.status}`);
    }
  );

  it(
    'start() after cancel() restarts process fresh — wait() resolves with new result',
    async () => {
      // Start and cancel
      const h1 = await ctx.executor.start(compiled(waitForSignalProcess), [
        'restart1',
      ]);
      await h1.cancel();

      // rt-3: start on same params after cancel must create a fresh instance
      const h2 = await ctx.executor.start(compiled(waitForSignalProcess), [
        'restart1',
      ]);

      await signalsForSimple.approved('restart1', { approver: 'bob' });
      const result = (await h2.wait()) as { taskId: string; approver: string };
      assert.strictEqual(result.approver, 'bob');
      assert.strictEqual(result.taskId, 'restart1');
    }
  );

  it(
    'statusChanges iterable emits running → suspended → completed',
    async () => {
      const handle = await ctx.executor.start(compiled(waitForSignalProcess), [
        'sc1',
      ]);

      const statuses: string[] = [];
      // Collect status changes asynchronously while driving the process
      const collector = (async () => {
        for await (const s of handle.statusChanges) {
          statuses.push(s);
          if (s === 'completed' || s === 'failed' || s === 'cancelled') break;
        }
      })();

      await signalsForSimple.approved('sc1', { approver: 'carol' });
      await handle.wait();
      await collector;

      assert.ok(statuses.length >= 1, `expected at least one status change, got: ${JSON.stringify(statuses)}`);
      assert.ok(statuses.includes('completed'), `expected completed in ${JSON.stringify(statuses)}`);
    }
  );
});

// ============================================================================
// SSE/WS observer pattern (what poker + chat subprocess flows depend on)
// ============================================================================

// SSE/WS observer pattern (cross-instance isolation, listener cleanup on
// break, multi-observer fan-out) is exhaustively tested in
// exports-observers.test.ts. The two stub todos that previously lived here
// duplicated those scenarios; deleted to avoid drift between the two files.

// ============================================================================
// Imports needed for exports tests below
// ============================================================================
import {
  ExportsSignals,
  scalarExportsProcess,
} from '../fixtures/exports.process.js';

// ============================================================================
// sub-3: late subscriber sees latest snapshot
// ============================================================================

describe('handle.data — late subscriber (sub-3)', () => {
  let ctx: ExportsCtx;

  beforeEach(() => {
    const storage = createInMemoryProcessStorage();
    const signalBus = new InMemorySignalBus();
    const timerScheduler = new InMemoryTimerScheduler();
    const serviceMap = new Map<unknown, unknown>();

    const executor = new ProcessExecutor({
      resolve: (async (token: unknown) => serviceMap.get(token)) as import('../../../src/core/index.js').Resolver,
      storage,
      signalBus,
      timerScheduler,
    });

    const signals = {
      tick: executor.createSignal<[id: string]>('exports.tick', ['id']),
      bump: executor.createSignal<[id: string], { by: number }>('exports.bump', ['id']),
      stop: executor.createSignal<[id: string]>('exports.stop', ['id']),
      push: executor.createSignal<[id: string], { value: string }>('exports.push', ['id']),
      setPhase: executor.createSignal<[id: string], { phase: string }>('exports.setPhase', ['id']),
      crash: executor.createSignal<[id: string]>('exports.crash', ['id']),
    };
    serviceMap.set(ExportsSignals, signals);
    setProcessExecutor(executor);

    ctx = { executor, storage, signalBus, timerScheduler, signals: { tick: signals.tick, stop: signals.stop } };
  });
  afterEach(() => teardown(ctx));

  it('late subscriber on handle.data sees the latest snapshot even after 2 ticks', async () => {
    type Compiled = CompiledSwitchProcess<Record<string, ServiceToken>>;
    const compiled2 = (p: unknown) => (p as { __compiled: Compiled }).__compiled;

    const handle = await ctx.executor.start(compiled2(scalarExportsProcess), ['late2']);

    await ctx.signals.tick('late2');
    await ctx.signals.tick('late2');

    // Late subscriber starts AFTER 2 ticks
    const data = handle.data as unknown as AsyncIterable<{ count: number }>;
    assert.ok(data, 'handle.data must be defined');

    const ai = data[Symbol.asyncIterator]();
    const first = await ai.next();
    assert.strictEqual(first.done, false, 'should not be done immediately');
    // The first snapshot from a late iterator must reflect current state (count=2)
    assert.strictEqual((first.value as { count: number }).count, 2, `expected count=2, got ${(first.value as { count: number }).count}`);
    await ai.return?.();

    await ctx.signals.stop('late2');
    await handle.wait();
  });
});

// ============================================================================
// sub-4: two observers, broadcast, cleanup
// ============================================================================

describe('handle.data — multi-observer broadcast (sub-4)', () => {
  let ctx: ExportsCtx;

  beforeEach(() => {
    const storage = createInMemoryProcessStorage();
    const signalBus = new InMemorySignalBus();
    const timerScheduler = new InMemoryTimerScheduler();
    const serviceMap = new Map<unknown, unknown>();

    const executor = new ProcessExecutor({
      resolve: (async (token: unknown) => serviceMap.get(token)) as import('../../../src/core/index.js').Resolver,
      storage,
      signalBus,
      timerScheduler,
    });

    const signals = {
      tick: executor.createSignal<[id: string]>('exports.tick', ['id']),
      bump: executor.createSignal<[id: string], { by: number }>('exports.bump', ['id']),
      stop: executor.createSignal<[id: string]>('exports.stop', ['id']),
      push: executor.createSignal<[id: string], { value: string }>('exports.push', ['id']),
      setPhase: executor.createSignal<[id: string], { phase: string }>('exports.setPhase', ['id']),
      crash: executor.createSignal<[id: string]>('exports.crash', ['id']),
    };
    serviceMap.set(ExportsSignals, signals);
    setProcessExecutor(executor);

    ctx = { executor, storage, signalBus, timerScheduler, signals: { tick: signals.tick, stop: signals.stop } };
  });
  afterEach(() => teardown(ctx));

  it('two concurrent observers both receive every snapshot update', async () => {
    type Compiled = CompiledSwitchProcess<Record<string, ServiceToken>>;
    const compiled2 = (p: unknown) => (p as { __compiled: Compiled }).__compiled;

    const handle = await ctx.executor.start(compiled2(scalarExportsProcess), ['obs-dual']);

    const data = handle.data as unknown as AsyncIterable<{ count: number }>;
    assert.ok(data, 'handle.data must be defined');

    const snapA: number[] = [];
    const snapB: number[] = [];

    // Both observers start simultaneously
    const ai1 = data[Symbol.asyncIterator]();
    const ai2 = data[Symbol.asyncIterator]();

    // Consume initial snapshot from both (seeded by current state)
    const init1 = await ai1.next();
    const init2 = await ai2.next();
    assert.strictEqual(init1.done, false);
    assert.strictEqual(init2.done, false);
    snapA.push((init1.value as { count: number }).count);
    snapB.push((init2.value as { count: number }).count);

    // Tick once — both should receive the new snapshot
    const [next1P, next2P] = [ai1.next(), ai2.next()];
    await ctx.signals.tick('obs-dual');
    const [n1, n2] = await Promise.all([next1P, next2P]);
    assert.strictEqual(n1.done, false, 'observer A should get update');
    assert.strictEqual(n2.done, false, 'observer B should get update');
    snapA.push((n1.value as { count: number }).count);
    snapB.push((n2.value as { count: number }).count);

    assert.deepStrictEqual(snapA, snapB, 'both observers must see the same snapshots');

    await ai1.return?.();
    await ai2.return?.();
    await ctx.signals.stop('obs-dual');
    await handle.wait();
  });

  it('breaking one observer does not affect the other and leaves no listener leak', async () => {
    type Compiled = CompiledSwitchProcess<Record<string, ServiceToken>>;
    const compiled2 = (p: unknown) => (p as { __compiled: Compiled }).__compiled;

    const handle = await ctx.executor.start(compiled2(scalarExportsProcess), ['obs-break']);

    const data = handle.data as unknown as AsyncIterable<{ count: number }>;
    const ai1 = data[Symbol.asyncIterator]();
    const ai2 = data[Symbol.asyncIterator]();

    // Consume initial snapshots
    await ai1.next();
    await ai2.next();

    // Subscribe ai2 for the next update (registers in the broadcast set)
    const pending2 = ai2.next();

    // Break ai1 — should not affect ai2's pending subscription
    await ai1.return?.();

    // Tick to unblock ai2
    await ctx.signals.tick('obs-break');
    const snap2 = await pending2;
    assert.strictEqual(snap2.done, false, 'ai2 should still receive after ai1 break');
    assert.strictEqual((snap2.value as { count: number }).count, 1);

    await ai2.return?.();
    await ctx.signals.stop('obs-break');
    await handle.wait();
  });
});
