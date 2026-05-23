/**
 * Fixtures exercising `using exports = { ... }`.
 *
 * Design-doc reference: memory/process-exports-design.md
 *   - `using exports` declares public state (real runtime object, not directive)
 *   - Real persisted var, not a using/rehydration var
 *   - External observers see typed, frozen, read-only replicas broadcast via
 *     channels with Symbol.asyncIterator
 *
 * `[Symbol.dispose]: () => {}` is required so plain `tsc` (and tsx) accept
 * the `using` declaration; ptsc rewrites the form regardless.
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
// Shared signals service for exports tests
// ============================================================================

export class ExportsSignals extends defineService({
  inject: { executor: AbstractProcessExecutor },
  factory: ({ executor }) => ({
    tick: executor.createSignal<[id: string]>('exports.tick', ['id']),
    bump: executor.createSignal<[id: string], { by: number }>('exports.bump', ['id']),
    stop: executor.createSignal<[id: string]>('exports.stop', ['id']),
    push: executor.createSignal<[id: string], { value: string }>('exports.push', ['id']),
    setPhase: executor.createSignal<[id: string], { phase: string }>(
      'exports.setPhase',
      ['id']
    ),
    crash: executor.createSignal<[id: string]>('exports.crash', ['id']),
  }),
}) {}

// Service whose method throws — used by fixtures that need a runtime
// failure path. Process handlers cannot throw directly (TSP3004), but
// awaiting a service that throws is fine; the executor catches it and
// transitions the process to 'failed'.
export class CrashService extends defineService({
  inject: {},
  factory: () => ({
    boom: async (): Promise<never> => {
      throw new Error('boom');
    },
  }),
}) {}

// ============================================================================
// Process: scalar counter in exports
// ============================================================================

export const scalarExportsProcess = createProcess({
  path: '/exports/scalar/:id',
  inject: { signals: ExportsSignals },

  async handler({ signals }, { id }) {
    using exports = {
      count: 0,
      [Symbol.dispose]: () => {},
    };

    while (true) {
      const r = race();
      switch (true) {
        case signal(r, signals.tick):
          exports.count++;
          break;
        case signal(r, signals.stop):
          return { final: exports.count };
      }
    }
  },
});

// ============================================================================
// Process: object exports — nested mutation
// ============================================================================

export const objectExportsProcess = createProcess({
  path: '/exports/object/:id',
  inject: { signals: ExportsSignals },

  async handler({ signals }, { id }) {
    using exports = {
      state: { phase: 'init', value: 0 },
      [Symbol.dispose]: () => {},
    };

    while (true) {
      const r = race();
      switch (true) {
        case signal(r, signals.setPhase):
          exports.state.phase = r.phase;
          break;
        case signal(r, signals.bump):
          exports.state.value += r.by;
          break;
        case signal(r, signals.stop):
          return { final: exports.state };
      }
    }
  },
});

// ============================================================================
// Process: array exports — push/splice
// ============================================================================

export const arrayExportsProcess = createProcess({
  path: '/exports/array/:id',
  inject: { signals: ExportsSignals },

  async handler({ signals }, { id }) {
    using exports = {
      events: [] as string[],
      [Symbol.dispose]: () => {},
    };

    while (true) {
      const r = race();
      switch (true) {
        case signal(r, signals.push):
          exports.events.push(r.value);
          break;
        case signal(r, signals.stop):
          return { final: exports.events };
      }
    }
  },
});

// ============================================================================
// Process: Map exports — coordinator-style registry
// ============================================================================

export const mapExportsProcess = createProcess({
  path: '/exports/map/:id',
  inject: { signals: ExportsSignals },

  async handler({ signals }, { id }) {
    using exports = {
      members: new Map<string, { phase: string }>(),
      [Symbol.dispose]: () => {},
    };

    while (true) {
      const r = race();
      switch (true) {
        case signal(r, signals.setPhase): {
          // Every tick: set phase for a synthetic member keyed off the phase value
          exports.members.set(r.phase, { phase: r.phase });
          break;
        }
        case signal(r, signals.stop): {
          const dump: Record<string, { phase: string }> = {};
          for (const [k, v] of exports.members) dump[k] = v;
          return { final: dump };
        }
      }
    }
  },
});

// ============================================================================
// Process: exports WITH methods — test method reattachment
// ============================================================================

export const methodExportsProcess = createProcess({
  path: '/exports/methods/:id',
  inject: { signals: ExportsSignals },

  async handler({ signals }, { id }) {
    using exports = {
      count: 0,
      double() {
        return this.count * 2;
      },
      [Symbol.dispose]: () => {},
    };

    while (true) {
      const r = race();
      switch (true) {
        case signal(r, signals.tick):
          exports.count++;
          break;
        case signal(r, signals.stop):
          return { doubled: exports.double() };
      }
    }
  },
});

// ============================================================================
// Process: exports then immediate return (completion semantics for handle.data)
// ============================================================================

export const completingExportsProcess = createProcess({
  path: '/exports/complete/:id',
  inject: {},

  async handler(_deps, { id }) {
    using exports = {
      phase: 'starting',
      [Symbol.dispose]: () => {},
    };
    exports.phase = 'running';
    exports.phase = 'done';
    return { id };
  },
});

// ============================================================================
// Process: exports then crash
// ============================================================================

export const crashingExportsProcess = createProcess({
  path: '/exports/crash/:id',
  inject: { signals: ExportsSignals, crash: CrashService },

  async handler({ signals, crash }, { id }) {
    using exports = {
      count: 0,
      [Symbol.dispose]: () => {},
    };
    exports.count = 1;

    while (true) {
      const r = race();
      switch (true) {
        case signal(r, signals.tick):
          exports.count++;
          break;
        case signal(r, signals.crash):
          await crash.boom();
      }
    }
  },
});
