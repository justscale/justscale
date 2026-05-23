/**
 * ScheduledTaskRepository
 *
 * Abstract repository for scheduled tasks. Extends ModelRepository with
 * scheduling-specific methods.
 *
 * Implementations (PostgreSQL, Redis, in-memory) provide:
 * - Durable storage of scheduled tasks
 * - Exactly-once pickup semantics via locking
 * - Subscription for task delivery via async iteration
 *
 * @example
 * ```typescript
 * // Schedule a task
 * const task = await scheduler.schedule({
 *   dueAt: new Date(Date.now() + 60_000),
 *   namespace: 'process',
 *   type: 'delay',
 *   payload: { processId: 'abc' },
 * })
 *
 * // Cancel if needed
 * await scheduler.cancel(task.id)
 *
 * // Subscribe and process tasks
 * for await (const task of scheduler.subscribe('process.delay')) {
 *   await handleTask(task)
 * }
 * ```
 */

import { ModelRepository } from '../model.repository.js';
import type { Persistent } from '../types.js';
import { ScheduledTask } from './scheduled-task.js';

/**
 * Options for scheduling a task.
 */
export interface ScheduleOptions<TPayload = unknown> {
  /** When the task should be executed */
  dueAt: Date
  /** Task namespace (e.g., 'process', 'email') */
  namespace: string
  /** Task type within namespace (e.g., 'delay', 'reminder') */
  type: string
  /** Task payload data */
  payload: TPayload
}

/**
 * Abstract repository for scheduled tasks.
 *
 * Extends ModelRepository<ScheduledTask> with scheduling-specific operations.
 * Implementations handle the actual storage and delivery mechanism.
 */
export abstract class ScheduledTaskRepository extends ModelRepository<ScheduledTask> {
  /**
   * Schedule a new task.
   *
   * Creates a task that will be delivered to subscribers of the qualified name
   * (namespace.type) when the dueAt time is reached.
   *
   * @param options - Task scheduling options
   * @returns The created task with ID and metadata
   *
   * @example
   * ```typescript
   * const task = await scheduler.schedule({
   *   dueAt: new Date(Date.now() + hours(24).ms),
   *   namespace: 'process',
   *   type: 'delay',
   *   payload: { processId: '123', instanceId: 'abc' },
   * })
   * ```
   */
  abstract schedule<TPayload = unknown>(
    options: ScheduleOptions<TPayload>
  ): Promise<Persistent<ScheduledTask>>;

  /**
   * Cancel a scheduled task.
   *
   * Can only cancel tasks that are still pending (not yet picked up).
   *
   * @param taskId - The task ID to cancel
   * @returns true if cancelled, false if not found or already processing
   *
   * @example
   * ```typescript
   * const cancelled = await scheduler.cancel(task.id)
   * if (!cancelled) {
   *   console.log('Task already started or not found')
   * }
   * ```
   */
  abstract cancel(taskId: string): Promise<boolean>;

  /**
   * Subscribe to tasks by qualified name.
   *
   * Returns an async iterable that yields tasks as they become due.
   * Each task is yielded to exactly one subscriber (exactly-once delivery).
   *
   * The implementation handles:
   * - Polling or push-based delivery (implementation-specific)
   * - Locking to ensure exactly-once pickup
   * - Marking tasks as completed after successful processing
   *
   * To stop subscribing, break out of the loop or use AbortController.
   *
   * @param qualifiedName - The namespace.type to subscribe to (e.g., 'process.delay')
   * @param options - Optional subscription options
   * @returns Async iterable of tasks
   *
   * @example
   * ```typescript
   * // Basic subscription
   * for await (const task of scheduler.subscribe('process.delay')) {
   *   await resumeProcess(task.payload as ProcessPayload)
   *   // Task is automatically marked completed after successful handling
   * }
   *
   * // With abort controller for graceful shutdown
   * const controller = new AbortController()
   * process.on('SIGTERM', () => controller.abort())
   *
   * for await (const task of scheduler.subscribe('process.delay', {
   *   signal: controller.signal,
   * })) {
   *   await handleTask(task)
   * }
   * ```
   */
  abstract subscribe(
    qualifiedName: string,
    options?: SubscribeOptions
  ): AsyncIterable<Persistent<ScheduledTask>>;
}

/**
 * Options for subscribing to tasks.
 */
export interface SubscribeOptions {
  /** AbortSignal for graceful shutdown */
  signal?: AbortSignal
  /** Polling interval in ms (for polling-based implementations) */
  pollInterval?: number
  /**
   * Reset tasks stuck in Processing status longer than this many ms back
   * to Pending so they can be re-delivered. Guards against worker crashes
   * that leave rows claimed but never completed. Defaults to 10 minutes;
   * pass a number to override or `false` to disable auto-recovery.
   */
  stuckAfterMs?: number | false
  /**
   * How often to check for stuck tasks (ms). Defaults to 60_000 (once per
   * minute); ignored when `stuckAfterMs: false`.
   */
  stuckCheckEveryMs?: number
}
