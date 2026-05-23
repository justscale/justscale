/**
 * Process Delay Controller
 *
 * Handles process delay timers via the ScheduledTask transport.
 * Add this controller to your cluster to enable durable process delays.
 *
 * @example
 * ```typescript
 * import '@justscale/process/cluster'
 * import '@justscale/core/cluster/scheduled-task'
 * import { ProcessDelayController } from '@justscale/process/delay-controller'
 *
 * const cluster = createClusterBuilder()
 *   .add(InMemoryScheduledTaskRepository)
 *   .add(ProcessDelayController)
 *   .build()
 * ```
 */

import { createController } from '../index.js';
import { z } from 'zod';
import { ScheduledTask } from '../cluster/scheduled-task/index.js';
import { ProcessRuntimeService } from './cluster-plugin.js';
import { TIMER_NAMESPACE, TIMER_TYPE } from '../runtime/process/scheduled-task-timer.js';
import { ADAPTER_KEY } from '../models/symbols.js';

/**
 * Zod schema for process delay task payloads.
 */
const TimerPayloadSchema = z.object({
  instanceId: z.string(),
  branchId: z.string().optional(),
});

/**
 * Controller that handles process delay timers.
 *
 * When a process calls `delay.seconds(30)`, the runtime schedules a task
 * with namespace 'process' and type 'delay'. This controller receives
 * those tasks when they're due and resumes the waiting process.
 */
export const ProcessDelayController = createController({
  inject: {
    runtime: ProcessRuntimeService,
  },
  routes: ({ runtime }) => ({
    handleDelay: ScheduledTask(TIMER_NAMESPACE, TIMER_TYPE)
      .payload(TimerPayloadSchema)
      .handle(async ({ task, payload }) => {
        runtime.handleTimerFired({
          timerId: (task as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string,
          instanceId: payload.instanceId,
          branchId: payload.branchId,
        });
      }),
  }),
});
