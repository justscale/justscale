/**
 * Process fixtures for the pg e2e tests.
 *
 * This file is consumed by `@justscale/typescript/register` - the loader
 * detects `.process.ts` and runs the createProcess transform. The module
 * is imported by test files so every app instance that loads them sees
 * the same compiled process definitions.
 */

import { createProcess, delay, race, signal } from '@justscale/core/process';
import { E2eSignals } from './e2e-signals.js';

/**
 * Wait for a single `go` signal, then return its payload.
 *
 * Instance key: `/e2e-wait/:id`. Cross-instance: whichever instance
 * wins the advisory lock runs the handler; the other proxies via the
 * signal bus.
 */
export const waitGo = createProcess({
  path: '/e2e-wait/:id',
  inject: { signals: E2eSignals },

  async handler({ signals }, { id }) {
    const r = race();
    switch (true) {
      case signal(r, signals.go):
        return { id, outcome: 'got-go' as const, note: r.note ?? null };
      case delay.seconds(r, 30):
        return { id, outcome: 'timeout' as const };
    }
  },
});

/**
 * Race between go and alt signals; returns which won. Exercises the
 * race narrowing + cross-instance signal routing simultaneously.
 */
export const raceGoAlt = createProcess({
  path: '/e2e-race/:id',
  inject: { signals: E2eSignals },

  async handler({ signals }, { id }) {
    const r = race();
    switch (true) {
      case signal(r, signals.go):
        return { id, winner: 'go' as const, note: r.note ?? null };
      case signal(r, signals.alt):
        return { id, winner: 'alt' as const, note: r.note ?? null };
      case delay.seconds(r, 30):
        return { id, winner: 'timeout' as const };
    }
  },
});

/**
 * Exercises service await inside a race branch. The handler's code runs
 * after a signal arrives; the compiler must emit `__blockResult = await ...`
 * for continuation steps inside branch arms.
 */
export const awaitInBranch = createProcess({
  path: '/e2e-await-branch/:id',
  inject: { signals: E2eSignals },

  async handler({ signals }, { id }) {
    const r = race();
    switch (true) {
      case signal(r, signals.go): {
        const echoed = await Promise.resolve({ v: r.note ?? 'n/a' });
        return { id, outcome: 'go' as const, echo: echoed.v };
      }
      case delay.seconds(r, 30):
        return { id, outcome: 'timeout' as const };
    }
  },
});

/**
 * Nested if + naked break inside a race branch. The compiler must emit
 * a continuation step even though the break is not at the top of the branch.
 */
export const nestedIfBreak = createProcess({
  path: '/e2e-nested-if/:id',
  inject: { signals: E2eSignals },

  async handler({ signals }, { id }) {
    while (true) {
      const r = race();
      switch (true) {
        case signal(r, signals.go): {
          if (r.note === 'stop') {
            return { id, stopped: true };
          }
          if (r.note) {
            if (r.note.length > 0) {
              // Naked break out of the switch - loops back around.
              break;
            }
          }
          return { id, stopped: false };
        }
        case delay.seconds(r, 30):
          return { id, stopped: false, timedOut: true };
      }
    }
  },
});

/**
 * Quick-delay process - tests that delay.seconds actually fires against
 * pg timer storage. One-second delay so tests don't spend forever.
 */
export const quickDelay = createProcess({
  path: '/e2e-delay/:id',
  inject: {},

  async handler(_deps, { id }) {
    const r = race();
    switch (true) {
      case delay.seconds(r, 1):
        return { id, outcome: 'timer-fired' as const };
    }
  },
});

/**
 * Counter loop - consumes `target` go-signals, then returns the count.
 *
 * Exercises the subscribe/match/re-subscribe cycle under the signal bus:
 * every go increments and re-enters the race, producing N subscribe INSERTs
 * and N match UPDATEs against the same instance. Used to probe subscription
 * table leaks and rapid-emit queueing.
 */
export const signalLoop = createProcess({
  path: '/e2e-loop/:id',
  inject: { signals: E2eSignals },

  async handler({ signals }, { id }) {
    let count = 0;
    const target = 5;
    while (true) {
      const r = race();
      switch (true) {
        case signal(r, signals.go):
          count++;
          if (count >= target) {
            return { id, count, timedOut: false as const };
          }
          break;
        case delay.seconds(r, 30):
          return { id, count, timedOut: true as const };
      }
    }
  },
});
