/**
 * Fixtures exercising `createSubProcess({ ... })`.
 *
 * Design-doc reference: memory/process-exports-design.md
 *
 * A subprocess is a named, addressable nested process with its own exports,
 * signals, and private state. Nested in parent's JSONB blob (NOT separate
 * rows). Shares parent's advisory lock.
 *
 * These fixtures exercise the shape the runtime is *expected* to support,
 * including pieces that are not yet fully wired (lifecycle, handle.wait,
 * handle.data over child exports). Tests are skipped/todo where the feature
 * is unimplemented.
 */

import { defineService } from '@justscale/core';
import {
  createProcess,
  createSubProcess,
  AbstractProcessExecutor,
  signal,
  race,
  delay,
} from '@justscale/core/process';

// ============================================================================
// Shared signals service for subprocess tests
// ============================================================================

export class SubSignals extends defineService({
  inject: { executor: AbstractProcessExecutor },
  factory: ({ executor }) => ({
    parentDone: executor.createSignal<[id: string]>('sub.parentDone', ['id']),
    childTick: executor.createSignal<[id: string, childId: string]>(
      'sub.childTick',
      ['id', 'childId']
    ),
    childDone: executor.createSignal<[id: string, childId: string]>(
      'sub.childDone',
      ['id', 'childId']
    ),
  }),
}) {}

// ============================================================================
// Parent process that spawns ONE subprocess, stores SubRef, then waits
// ============================================================================

export const parentWithOneChildProcess = createProcess({
  path: '/subproc/one/:id',
  inject: { signals: SubSignals },

  async handler({ signals }, { id }) {
    const child = createSubProcess({
      name: 'child',
      path: '/:childId',
      async handler(childId: string) {
        using exports = {
          tickCount: 0,
          [Symbol.dispose]: () => {},
        };

        while (true) {
          const r = race();
          switch (true) {
            case signal(r, signals.childTick):
              exports.tickCount++;
              break;
            case signal(r, signals.childDone):
              return { childId, ticks: exports.tickCount };
          }
        }
      },
    });

    const alice = await child('alice');

    // Expected: parent can wait for child via the handle.
    // Current: implementation stores a SubRef but does not actually
    // run the child execute().
    await signal(signals.parentDone);
    return { parent: id, aliceRef: alice };
  },
});

// ============================================================================
// Parent that spawns TWO children (same subprocess, different args)
// ============================================================================

export const parentWithTwoChildrenProcess = createProcess({
  path: '/subproc/two/:id',
  inject: { signals: SubSignals },

  async handler({ signals }, { id }) {
    const child = createSubProcess({
      name: 'child',
      path: '/:childId',
      async handler(childId: string) {
        await signal(signals.childDone);
        return { childId };
      },
    });

    const alice = await child('alice');
    const bob = await child('bob');
    await signal(signals.parentDone);
    return { parent: id, aliceRef: alice, bobRef: bob };
  },
});

// ============================================================================
// Parent that spawns same subprocess twice with same args (idempotent?)
// ============================================================================

export const parentSameArgsTwiceProcess = createProcess({
  path: '/subproc/dup/:id',
  inject: { signals: SubSignals },

  async handler({ signals }, { id }) {
    const child = createSubProcess({
      name: 'child',
      path: '/:childId',
      async handler(childId: string) {
        await signal(signals.childDone);
        return { childId };
      },
    });

    const first = await child('alice');
    const second = await child('alice');
    await signal(signals.parentDone);
    return { parent: id, first, second };
  },
});
