/**
 * ScheduledTask Model
 *
 * A scheduled task represents work to be executed at a specific time.
 * Used for durable timers in processes, scheduled jobs, reminders, etc.
 *
 * Tasks are identified by namespace.type (e.g., 'process.delay', 'email.reminder').
 * Workers subscribe to specific qualified names and receive tasks as an async iterable.
 *
 * @example
 * ```typescript
 * // Schedule a process delay
 * await scheduler.schedule({
 *   dueAt: new Date(Date.now() + 60_000),
 *   namespace: 'process',
 *   type: 'delay',
 *   payload: { processId: 'abc', instanceId: '123' },
 * })
 *
 * // Subscribe to process delays
 * for await (const task of scheduler.subscribe('process.delay')) {
 *   await resumeProcess(task.payload)
 * }
 * ```
 */

import { defineModel } from '../define-model.js';
import { field } from '../field.js';

/**
 * Task status values.
 */
export const ScheduledTaskStatus = {
  /** Task is waiting to be executed */
  Pending: 'pending',
  /** Task is currently being processed */
  Processing: 'processing',
  /** Task completed successfully */
  Completed: 'completed',
  /** Task was cancelled before execution */
  Cancelled: 'cancelled',
  /** Task failed during execution */
  Failed: 'failed',
} as const;

export type ScheduledTaskStatus = (typeof ScheduledTaskStatus)[keyof typeof ScheduledTaskStatus];

/**
 * ScheduledTask model.
 *
 * Represents a task scheduled to run at a specific time.
 */
export class ScheduledTask extends defineModel({
  name: 'JustScale_ScheduledTask',
  fields: {
    /** When the task should be executed */
    dueAt: field.timestamp(),
    /** Task namespace (e.g., 'process', 'email', 'notifications') */
    namespace: field.string().max(64).index(),
    /** Task type within namespace (e.g., 'delay', 'reminder', 'cleanup') */
    type: field.string().max(64).index(),
    /** Task payload - the data needed to execute the task */
    payload: field.json<unknown>(),
    /** Current task status */
    status: field.enum('scheduled_task_status', [
      'pending',
      'processing',
      'completed',
      'cancelled',
      'failed',
    ] as const).default('pending'),
    /** When the task started processing (set when picked up) */
    startedAt: field.timestamp().optional(),
    /** When the task completed/failed (set on completion) */
    completedAt: field.timestamp().optional(),
    /** Error message if task failed */
    error: field.text().optional(),
  },
}) {
  /**
   * Get the fully qualified task name.
   * Format: namespace.type (e.g., 'process.delay')
   */
  get qualifiedName(): string {
    return `${this.namespace}.${this.type}`;
  }

  /**
   * Check if the task is due for execution.
   */
  isDue(now = new Date()): boolean {
    return this.dueAt <= now && this.status === 'pending';
  }

  /**
   * Check if the task can still be cancelled.
   */
  get isCancellable(): boolean {
    return this.status === 'pending';
  }
}
