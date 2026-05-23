/**
 * @justscale/process - Scheduled Task Timer Scheduler
 *
 * Bridges the TimerScheduler interface with ScheduledTaskRepository.
 * Uses the general-purpose scheduled task system for durable process timers.
 *
 * Note: This scheduler does NOT subscribe to tasks itself. The transport
 * plugin handles subscription via ProcessDelayController, which calls
 * receiveFire() when tasks are due.
 */

import { defineService } from '../../index.js';
import { ScheduledTaskRepository, ScheduledTask, q } from '../../models/index.js';
import { ADAPTER_KEY } from '../../models/symbols.js';
import type { TimerScheduler, TimerFired } from './timer-scheduler.js';

/** Namespace for process timers in the scheduled task system */
export const TIMER_NAMESPACE = 'process';
/** Type for process delay timers */
export const TIMER_TYPE = 'delay';

/**
 * Timer payload stored in scheduled tasks.
 */
export interface TimerPayload {
  instanceId: string
  branchId?: string
}

/**
 * Scheduled task timer scheduler service.
 *
 * Uses DI to inject the ScheduledTaskRepository. Provides durable timers
 * for processes using the general-purpose scheduled task system.
 *
 * Timer firing is handled externally via the scheduled task transport
 * plugin, which calls receiveFire() when tasks are due.
 *
 * @example
 * ```typescript
 * const built = createClusterBuilder()
 *   .add(bindService(ScheduledTaskRepository, PgScheduledTaskRepositoryService))
 *   .add(ScheduledTaskTimerScheduler)
 *   .build()
 *
 * const scheduler = app.container.resolve(ScheduledTaskTimerScheduler)
 * scheduler.start()
 * ```
 */
export class ScheduledTaskTimerScheduler extends defineService({
  inject: {
    repository: ScheduledTaskRepository,
  },
  factory: ({ repository }): TimerScheduler & { qualifiedName: string } => {
    const fireCallbacks = new Set<(fired: TimerFired) => void>();

    function notifyFire(fired: TimerFired): void {
      for (const callback of fireCallbacks) {
        try {
          callback(fired);
        } catch (e) {
          console.error('[ScheduledTaskTimerScheduler] Fire callback error:', e);
        }
      }
    }

    return {
      async schedule(instanceId: string, expiresAt: Date, branchId?: string): Promise<string> {
        const payload: TimerPayload = { instanceId, branchId };

        const task = await repository.schedule({
          dueAt: expiresAt,
          namespace: TIMER_NAMESPACE,
          type: TIMER_TYPE,
          payload,
        });

        return (task as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string;
      },

      async cancel(timerId: string): Promise<void> {
        await repository.cancel(timerId);
      },

      async cancelAll(instanceId: string): Promise<void> {
        const { namespace, type, status } = ScheduledTask.fields;

        const tasks = await repository.find({
          where: q.and(
            namespace.eq(TIMER_NAMESPACE),
            type.eq(TIMER_TYPE),
            status.eq('pending')
          ),
        });

        for (const task of tasks) {
          const payload = task.payload as TimerPayload;
          if (payload.instanceId === instanceId) {
            await repository.cancel((task as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string);
          }
        }
      },

      onFire(callback: (fired: TimerFired) => void): () => void {
        fireCallbacks.add(callback);
        return () => fireCallbacks.delete(callback);
      },

      receiveFire(fired: TimerFired): void {
        notifyFire(fired);
      },

      async checkExpired(_now?: Date): Promise<TimerFired[]> {
        // Not used - transport handles task polling
        return [];
      },

      start(): void {
        // No-op - transport handles subscription
      },

      stop(): void {
        // No-op - transport handles subscription
      },

      get qualifiedName(): string {
        return `${TIMER_NAMESPACE}.${TIMER_TYPE}`;
      },
    };
  },
}) {}
