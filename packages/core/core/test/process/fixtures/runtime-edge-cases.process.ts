/**
 * Process fixtures exercising runtime edge cases.
 *
 * These definitions are compiled by `@justscale/typescript/register`
 * before running. Each export stresses a different property of the
 * executor/signal-bus/timer-scheduler triad that a mock compiled
 * process would let us cheat on.
 *
 * IMPORTANT: Do not add `@ts-expect-error` markers here. These are
 * real source inputs for the compiler.
 */
import { defineService } from '@justscale/core';
import {
  createProcess,
  AbstractProcessExecutor,
  signal,
  race,
  delay,
} from '@justscale/core/process';

// ============================================================================
// Signal bundle used by every fixture below
// ============================================================================

export class EdgeSignals extends defineService({
  inject: { executor: AbstractProcessExecutor },
  factory: ({ executor }) => ({
    // A single-shot signal with a typed payload.
    tick: executor.createSignal<[id: string], { n: number }>(
      'edge.tick',
      ['id'],
    ),

    // Secondary signal used to compose multi-branch races.
    kill: executor.createSignal<[id: string], { reason: string }>(
      'edge.kill',
      ['id'],
    ),

    // A void-payload signal. Exercises `void` handling in payload decoders.
    ping: executor.createSignal<[id: string]>(
      'edge.ping',
      ['id'],
    ),

    // A signal with two identity params — exercises multi-key identity
    // matching in the signal bus.
    pair: executor.createSignal<[a: string, b: string], { who: string }>(
      'edge.pair',
      ['a', 'b'],
    ),
  }),
}) {}

// Service whose method throws — process handlers cannot throw directly
// (TSP3004), so failure-path fixtures await this service to surface a
// real error. The executor catches it and transitions the process to
// 'failed', which is what the error-propagation tests assert against.
export class EdgeCrashService extends defineService({
  inject: {},
  factory: () => ({
    boomBeforeSuspend: async (): Promise<never> => {
      throw new Error('boom-before-suspend');
    },
    boomAfterSignal: async (): Promise<never> => {
      throw new Error('boom-after-signal');
    },
  }),
}) {}

// ============================================================================
// Fixture: await a single signal, echo the payload
// ============================================================================

export const awaitTick = createProcess({
  path: '/edge/await-tick/:id',
  inject: { signals: EdgeSignals },

  async handler({ signals }, { id }) {
    const tick = await signal(signals.tick);
    return { id, n: tick.n };
  },
});

// ============================================================================
// Fixture: race three signal branches (no timer). Only one fires.
// ============================================================================

export const threeBranchRace = createProcess({
  path: '/edge/three-branch/:id',
  inject: { signals: EdgeSignals },

  async handler({ signals }, { id }) {
    const r = race();
    switch (true) {
      case signal(r, signals.tick):
        return { id, which: 'tick', n: r.n };
      case signal(r, signals.kill):
        return { id, which: 'kill', reason: r.reason };
      case signal(r, signals.ping):
        return { id, which: 'ping' };
    }
  },
});

// ============================================================================
// Fixture: race a signal vs two delays. Exercises "smallest delay wins"
// and "signal beats delay".
// ============================================================================

export const twoDelayRace = createProcess({
  path: '/edge/two-delay/:id',
  inject: { signals: EdgeSignals },

  async handler({ signals }, { id }) {
    const r = race();
    switch (true) {
      case signal(r, signals.tick):
        return { id, which: 'tick', n: r.n };
      case delay.seconds(r, 1):
        return { id, which: 'short-timer' };
      case delay.minutes(r, 10):
        return { id, which: 'long-timer' };
    }
  },
});

// ============================================================================
// Fixture: loop that counts how many ticks arrive before a kill.
// Exercises re-subscription on each loop iteration.
// ============================================================================

export const countUntilKill = createProcess({
  path: '/edge/count-until-kill/:id',
  inject: { signals: EdgeSignals },

  async handler({ signals }, { id }) {
    let count = 0;
     
    while (true) {
      const r = race();
      switch (true) {
        case signal(r, signals.tick):
          count++;
          continue;
        case signal(r, signals.kill):
          return { id, count, reason: r.reason };
      }
    }
  },
});

// ============================================================================
// Fixture: await a pair-keyed signal. Exercises multi-param identity.
// ============================================================================

export const awaitPair = createProcess({
  path: '/edge/pair/:a/:b',
  inject: { signals: EdgeSignals },

  async handler({ signals }, { a, b }) {
    const p = await signal(signals.pair);
    return { a, b, who: p.who };
  },
});

// ============================================================================
// Fixture: handler throws before first suspension. Exercises the
// "fail fast, no suspension" error path.
// ============================================================================

export const throwsBeforeSuspend = createProcess({
  path: '/edge/throws-before/:id',
  inject: { crash: EdgeCrashService },

  async handler({ crash }, _params) {
    await crash.boomBeforeSuspend();
  },
});

// ============================================================================
// Fixture: throws AFTER first suspension, inside the race branch body.
// Exercises the "fail after resume" error path. The process suspends
// first, then on resume throws from the signal branch.
// ============================================================================

export const throwsAfterSignal = createProcess({
  path: '/edge/throws-after/:id',
  inject: { signals: EdgeSignals, crash: EdgeCrashService },

  async handler({ signals, crash }, _params) {
    await signal(signals.tick);
    await crash.boomAfterSignal();
  },
});

// ============================================================================
// Fixture: two sequential suspensions (non-race). Exercises step
// progression across multiple suspensions.
// ============================================================================

export const twoSuspends = createProcess({
  path: '/edge/two-suspends/:id',
  inject: { signals: EdgeSignals },

  async handler({ signals }, { id }) {
    const a = await signal(signals.tick);
    const b = await signal(signals.tick);
    return { id, first: a.n, second: b.n };
  },
});

// ============================================================================
// Fixture: emits a signal to itself (self-dispatch) and awaits it.
// Exercises the emit-while-subscribed path where a process triggers
// its own resumption.
// ============================================================================

export const selfDispatch = createProcess({
  path: '/edge/self-dispatch/:id',
  inject: { signals: EdgeSignals },

  async handler({ signals }, { id }) {
    // Fire and forget — the emit happens before the suspend, but after
    // subscribe (impossible; see notes). The purpose here is to doc
    // that emit() before the race() registers the race subscription
    // is a NO-OP. The compiler sequences the race+suspend after this.
    await signals.tick(id, { n: 999 });

    const r = race();
    switch (true) {
      case signal(r, signals.tick):
        // If semantics were "emit before subscribe is queued", we'd
        // see n=999 here. Under the actual semantics (no queuing of
        // pre-subscription emits) we have to emit again from outside
        // to unblock, so this branch is only exercised by the test's
        // post-start emit.
        return { id, n: r.n };
      case delay.seconds(r, 1):
        return { id, n: -1 };
    }
  },
});
