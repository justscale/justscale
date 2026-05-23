/**
 * Simple Process Fixture for Integration Testing
 *
 * This process demonstrates the basic patterns without complex dependencies:
 * - Simple signal waiting
 * - Race between signal and delay
 * - Using signal payload values
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
// Simple Service with Signals
// ============================================================================

export class SimpleSignals extends defineService({
  inject: {
    executor: AbstractProcessExecutor,
  },
  factory: ({ executor }) => ({
    // Signal: emitted when a task is approved
    approved: executor.createSignal<[taskId: string], { approver: string }>(
      'simple.approved',
      ['taskId']
    ),

    // Signal: emitted when a task is rejected
    rejected: executor.createSignal<[taskId: string], { reason: string }>(
      'simple.rejected',
      ['taskId']
    ),
  }),
}) {}

// ============================================================================
// Process: Immediate completion (no suspension)
// ============================================================================

export const immediateProcess = createProcess({
  path: '/immediate/:id',
  inject: {},

  async handler(_deps, { id }) {
    return { id, status: 'completed' };
  },
});

// ============================================================================
// Process: Wait for single signal
// ============================================================================

export const waitForSignalProcess = createProcess({
  path: '/wait-signal/:taskId',
  inject: {
    signals: SimpleSignals,
  },

  async handler({ signals }, { taskId }) {
    // Wait for approval signal
    const approval = await signal(signals.approved);
    return {
      taskId,
      approved: true,
      approver: approval.approver,
    };
  },
});

// ============================================================================
// Process: Race between signal and timeout
// ============================================================================

export const raceProcess = createProcess({
  path: '/race/:taskId',
  inject: {
    signals: SimpleSignals,
  },

  async handler({ signals }, { taskId }) {
    const r = race();

    switch (true) {
      case signal(r, signals.approved):
        return {
          taskId,
          outcome: 'approved',
          approver: r.approver,
        };

      case signal(r, signals.rejected):
        return {
          taskId,
          outcome: 'rejected',
          reason: r.reason,
        };

      case delay.seconds(r, 30):
        return {
          taskId,
          outcome: 'timeout',
        };
    }
  },
});
