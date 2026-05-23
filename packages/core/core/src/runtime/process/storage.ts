/**
 * @justscale/process - Process Storage
 *
 * Abstraction for persisting process state.
 */

import type { ProcessState, ProcessStatus } from '../../process/types.js';
import { defineAbstract, defineService } from '../../core/service.js';

// ============================================================================
// Storage Interface
// ============================================================================

/**
 * Abstract storage interface for process state persistence.
 *
 * Implementations:
 * - InMemoryProcessStorage (testing/development)
 * - PgProcessStorage (production - in @justscale/postgres)
 */
export interface ProcessStorage {
  // === Core CRUD ===

  /** Save or update process state */
  save(state: ProcessState): Promise<void>

  /** Load process state by instance ID. Returns null if not found. */
  load(instanceId: string): Promise<ProcessState | null>

  /** Delete a process state */
  delete(instanceId: string): Promise<void>

  // === Status Transitions ===

  /** Mark process as completed with result */
  complete(instanceId: string, result: unknown): Promise<void>

  /** Mark process as failed with error */
  fail(instanceId: string, error: string): Promise<void>

  // === Queries ===

  /** Find processes by process definition ID */
  findByProcessId(processId: string): AsyncIterable<ProcessState>

  /** Find processes by status */
  findByStatus(status: ProcessStatus): AsyncIterable<ProcessState>

  /** Find processes waiting for a specific signal */
  findWaitingForSignal(signal: string, identity: Record<string, string>): AsyncIterable<ProcessState>

  /** Find processes with expired timers */
  findExpiredTimers(before: Date): AsyncIterable<ProcessState>
}

// ============================================================================
// Abstract Class for DI
// ============================================================================

/**
 * Abstract ProcessStorage for dependency injection.
 *
 * Use this as a DI token. Implementations (InMemory, Postgres) provide this.
 *
 * @example
 * ```typescript
 * // Use InMemory (auto-provides AbstractProcessStorage)
 * .add(InMemoryProcessStorage)
 *
 * // Or use Postgres feature
 * .add(PostgresProcessFeature)
 * ```
 */
export abstract class AbstractProcessStorage extends defineAbstract<ProcessStorage>('AbstractProcessStorage') {}

// ============================================================================
// In-Memory Implementation
// ============================================================================

/** Return type for createInMemoryProcessStorage */
export type InMemoryProcessStorageInstance = ProcessStorage & {
  /** Clear all stored processes */
  clear(): void
  /** Get count of processes */
  readonly size: number
  /** Get stats by status */
  getStats(): Record<ProcessStatus, number>
};

/**
 * Create an in-memory process storage instance.
 *
 * Use this function for testing or when you need a direct instance.
 * For DI, use `InMemoryProcessStorage` service instead.
 *
 * @example
 * ```typescript
 * // Direct instantiation for testing
 * const storage = createInMemoryProcessStorage()
 * storage.save(state)
 * storage.clear()
 * ```
 */
export function createInMemoryProcessStorage(): InMemoryProcessStorageInstance {
  const processes = new Map<string, ProcessState>();

  function matchesIdentity(
    stateIdentity: Record<string, string>,
    queryIdentity: Record<string, string>
  ): boolean {
    for (const [key, value] of Object.entries(queryIdentity)) {
      if (stateIdentity[key] !== value) return false;
    }
    return true;
  }

  return {
    async save(state: ProcessState): Promise<void> {
      state.updatedAt = new Date();
      processes.set(state.instanceId, structuredClone(state));
    },

    async load(instanceId: string): Promise<ProcessState | null> {
      const state = processes.get(instanceId);
      return state ? structuredClone(state) : null;
    },

    async delete(instanceId: string): Promise<void> {
      processes.delete(instanceId);
    },

    async complete(instanceId: string, result: unknown): Promise<void> {
      const state = processes.get(instanceId);
      if (state) {
        state.status = 'completed';
        state.result = result;
        state.completedAt = new Date();
        state.updatedAt = new Date();
      }
    },

    async fail(instanceId: string, error: string): Promise<void> {
      const state = processes.get(instanceId);
      if (state) {
        state.status = 'failed';
        state.error = error;
        state.completedAt = new Date();
        state.updatedAt = new Date();
      }
    },

    async *findByProcessId(processId: string): AsyncIterable<ProcessState> {
      for (const state of processes.values()) {
        if (state.processId === processId) {
          yield structuredClone(state);
        }
      }
    },

    async *findByStatus(status: ProcessStatus): AsyncIterable<ProcessState> {
      for (const state of processes.values()) {
        if (state.status === status) {
          yield structuredClone(state);
        }
      }
    },

    async *findWaitingForSignal(
      signal: string,
      identity: Record<string, string>
    ): AsyncIterable<ProcessState> {
      for (const state of processes.values()) {
        if (state.status !== 'suspended') continue;

        const waiting = state.variables['__waitingForSignal'] as string | undefined;
        if (waiting !== signal) continue;

        // Check identity match
        const stateIdentity = state.variables['__signalIdentity'] as Record<string, string> | undefined;
        if (stateIdentity && !matchesIdentity(stateIdentity, identity)) continue;

        yield structuredClone(state);
      }
    },

    async *findExpiredTimers(before: Date): AsyncIterable<ProcessState> {
      for (const state of processes.values()) {
        if (state.status !== 'suspended') continue;

        for (const timer of state.timers) {
          if (timer.expiresAt <= before) {
            yield structuredClone(state);
            break;
          }
        }
      }
    },

    // === Testing Utilities ===

    clear(): void {
      processes.clear();
    },

    get size(): number {
      return processes.size;
    },

    getStats(): Record<ProcessStatus, number> {
      const stats: Record<ProcessStatus, number> = {
        pending: 0,
        running: 0,
        suspended: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };
      for (const state of processes.values()) {
        stats[state.status]++;
      }
      return stats;
    },
  };
}

/**
 * In-memory process storage service for DI.
 *
 * Not suitable for production - state is lost on restart.
 *
 * @example
 * ```typescript
 * // For DI - auto-provides AbstractProcessStorage
 * JustScale()
 *   .add(InMemoryProcessStorage)
 *   .add(ProcessExecutor)
 *   .build()
 *
 * // For testing - use createInMemoryProcessStorage() instead
 * const storage = createInMemoryProcessStorage()
 * ```
 */
export class InMemoryProcessStorage extends defineService({
  inject: {},
  provides: [AbstractProcessStorage],
  factory: createInMemoryProcessStorage,
}) {}
