import { ADAPTER_KEY, defineModel, field } from '@justscale/core/models';
import { createPgModel } from '../model/pg-model.js';
import { createPgRepository } from '../repository/pg-repository-service.js';
import { PG_CREATED_AT, PG_UPDATED_AT } from '../repository/pg-repository.js';

/** Extract adapter key from a persistent entity */
function keyOf(entity: unknown): string {
  const key = (entity as Record<symbol, unknown>)[ADAPTER_KEY];
  if (key === undefined) throw new Error('Entity has no adapter key - not persistent');
  return key as string;
}


type ProcessStatus =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed';

interface TimerState {
  id: string
  expiresAt: Date
  opcodeIndex: number
}

interface ProcessState<TVariables = Record<string, unknown>> {
  processId: string
  instanceId: string
  version: string
  pc: number
  variables: TVariables
  timers: TimerState[]
  createdAt: Date
  updatedAt: Date
  suspendedAt?: Date
  completedAt?: Date
  status: ProcessStatus
  result?: unknown
  error?: string
  lastError?: string
  lastErrorAt?: Date
}

interface ProcessStorage {
  save(state: ProcessState): Promise<void>
  load(instanceId: string): Promise<ProcessState | null>
  delete(instanceId: string): Promise<void>
  complete(instanceId: string, result: unknown): Promise<void>
  fail(instanceId: string, error: string): Promise<void>
  findByProcessId(processId: string): AsyncIterable<ProcessState>
  findByStatus(status: ProcessStatus): AsyncIterable<ProcessState>
  findWaitingForSignal(
    signal: string,
    identity: Record<string, string>,
  ): AsyncIterable<ProcessState>
  findExpiredTimers(before: Date): AsyncIterable<ProcessState>
}


/**
 * Domain model for process execution state.
 */
export class ProcessExecution extends defineModel({
  name: 'JustScale_ProcessExecution',
  fields: {
    /** Process definition ID */
    processId: field.string().max(255),
    /** Instance ID (derived from path + params) */
    instanceId: field.string().max(512).unique(),
    /** Version hash of opcode structure */
    codeVersion: field.string().max(64),
    /** Program counter - current opcode index */
    pc: field.int().default(0),
    /** Serialized variables as JSONB */
    variables: field.json<Record<string, unknown>>().default({}),
    /** Pending timers as JSONB */
    timers: field.json<TimerState[]>().default([]),
    /** Process status */
    status: field.string().max(20).default('pending'),
    /** Result on completion */
    result: field.json<unknown>().optional(),
    /** Error message on failure */
    error: field.string().optional(),
    /** Last recoverable error (e.g. DoubleLockError); paused-not-failed */
    lastError: field.string().optional(),
    /** Timestamp of the last recoverable error */
    lastErrorAt: field.date().optional(),
    /** When the process was suspended */
    suspendedAt: field.date().optional(),
    /** When the process completed */
    completedAt: field.date().optional(),
  },
}) {}


/**
 * PostgreSQL-specific process execution model.
 */
export const PgProcessExecution = createPgModel(ProcessExecution, {
  table: 'process_executions',
});

/**
 * Repository service for process executions.
 * Register this in your DI container.
 */
export const ProcessExecutionRepository = createPgRepository(PgProcessExecution);


type ProcessExecutionRepo = {
  findOne(condition: any): Promise<any>
  find(options?: any): Promise<any[]>
  create(data: any): Promise<any>
  update(id: string, data: any): Promise<any>
  delete(id: string): Promise<void>
};

/**
 * Create a ProcessStorage adapter from a ProcessExecution repository.
 *
 * @example
 * ```typescript
 * const repo = container.resolve(ProcessExecutionRepository)
 * const storage = createProcessStorage(repo)
 * ```
 */
export function createProcessStorage(
  repo: ProcessExecutionRepo,
): ProcessStorage {
  return {
    async save(state: ProcessState): Promise<void> {
      const existing = await repo.findOne(
        ProcessExecution.fields.instanceId.eq(state.instanceId),
      );

      const data = {
        processId: state.processId,
        instanceId: state.instanceId,
        codeVersion: state.version,
        pc: state.pc,
        variables: state.variables,
        timers: state.timers,
        status: state.status,
        result: state.result ?? null,
        error: state.error ?? null,
        lastError: state.lastError ?? null,
        lastErrorAt: state.lastErrorAt ?? null,
        suspendedAt: state.suspendedAt ?? null,
        completedAt: state.completedAt ?? null,
      };

      if (existing) {
        await repo.update(keyOf(existing), data);
      } else {
        await repo.create(data);
      }
    },

    async load(instanceId: string): Promise<ProcessState | null> {
      const entity = await repo.findOne(
        ProcessExecution.fields.instanceId.eq(instanceId),
      );
      if (!entity) return null;
      return toProcessState(entity);
    },

    async delete(instanceId: string): Promise<void> {
      const entity = await repo.findOne(
        ProcessExecution.fields.instanceId.eq(instanceId),
      );
      if (entity) {
        await repo.delete(keyOf(entity));
      }
    },

    async complete(instanceId: string, result: unknown): Promise<void> {
      const entity = await repo.findOne(
        ProcessExecution.fields.instanceId.eq(instanceId),
      );
      if (entity) {
        await repo.update(keyOf(entity), {
          status: 'completed',
          result,
          completedAt: new Date(),
        });
      }
    },

    async fail(instanceId: string, error: string): Promise<void> {
      const entity = await repo.findOne(
        ProcessExecution.fields.instanceId.eq(instanceId),
      );
      if (entity) {
        await repo.update(keyOf(entity), {
          status: 'failed',
          error,
          completedAt: new Date(),
        });
      }
    },

    async *findByProcessId(processId: string): AsyncIterable<ProcessState> {
      const entities = await repo.find({
        where: ProcessExecution.fields.processId.eq(processId),
      });
      for (const entity of entities) {
        yield toProcessState(entity);
      }
    },

    async *findByStatus(status: ProcessStatus): AsyncIterable<ProcessState> {
      const entities = await repo.find({
        where: ProcessExecution.fields.status.eq(status),
      });
      for (const entity of entities) {
        yield toProcessState(entity);
      }
    },

    async *findWaitingForSignal(
      signal: string,
      identity: Record<string, string>,
    ): AsyncIterable<ProcessState> {
      // Get all suspended processes and filter by signal in memory
      // A production impl would use JSONB queries
      const entities = await repo.find({
        where: ProcessExecution.fields.status.eq('suspended'),
      });

      for (const entity of entities) {
        const variables = entity.variables as Record<string, unknown>;
        if (variables.__waitingForSignal !== signal) continue;

        // Check identity match
        const stateIdentity = variables.__signalIdentity as
          | Record<string, string>
          | undefined;
        if (stateIdentity) {
          let matches = true;
          for (const [key, value] of Object.entries(identity)) {
            if (stateIdentity[key] !== value) {
              matches = false;
              break;
            }
          }
          if (!matches) continue;
        }

        yield toProcessState(entity);
      }
    },

    async *findExpiredTimers(before: Date): AsyncIterable<ProcessState> {
      // Get all suspended processes and check timers
      const entities = await repo.find({
        where: ProcessExecution.fields.status.eq('suspended'),
      });

      for (const entity of entities) {
        const timers = entity.timers as TimerState[];
        const hasExpired = timers.some((t) => new Date(t.expiresAt) <= before);
        if (hasExpired) {
          yield toProcessState(entity);
        }
      }
    },
  };
}

/**
 * Convert repository entity to ProcessState.
 */
function toProcessState(entity: any): ProcessState {
  return {
    processId: entity.processId,
    instanceId: entity.instanceId,
    version: entity.codeVersion,
    pc: entity.pc,
    variables: entity.variables,
    timers: entity.timers,
    status: entity.status as ProcessStatus,
    result: entity.result,
    error: entity.error,
    lastError: entity.lastError,
    lastErrorAt: entity.lastErrorAt,
    suspendedAt: entity.suspendedAt,
    completedAt: entity.completedAt,
    createdAt: entity[PG_CREATED_AT],
    updatedAt: entity[PG_UPDATED_AT],
  };
}


import {
  AbstractChannelBackend,
  AbstractLockProvider,
  Lifecycle,
  bindService,
  createFeatureBuilder,
} from '@justscale/core';

const TRACE_ENABLED = process.env.JUSTSCALE_TRACE === '1' || process.env.JUSTSCALE_TRACE === 'true';
function trace(component: string, message: string, data?: Record<string, unknown>): void {
  if (!TRACE_ENABLED) return;
  const timestamp = new Date().toISOString();
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  console.debug(`[${timestamp}] [TRACE] [${component}] ${message}${dataStr}`);
}
import { defineService } from '@justscale/core/di';
import {
  AbstractProcessExecutor,
  AbstractProcessStorage,
  AbstractSignalBus,
  ProcessExecutorService,
} from '@justscale/core/process';
import { AbstractPostgresClient } from '../client/client.js';
import { ModelChangeChannels } from '../repository/pg-repository-service.js';
import { PgSignalBus, SignalSubscriptionRepository } from './process-signal-bus.js';

/**
 * Service that provides PostgreSQL-backed process storage.
 * Uses direct SQL via AbstractPostgresClient (no channels needed).
 */
export class PgProcessStorageService extends defineService({
  inject: { client: AbstractPostgresClient },
  factory: ({ client }): ProcessStorage => new PgProcessStorageImpl(client),
}) {}

/**
 * Direct PostgreSQL implementation of ProcessStorage.
 * Uses raw SQL queries - simpler than the repository approach.
 */
class PgProcessStorageImpl implements ProcessStorage {
  constructor(private client: InstanceType<typeof AbstractPostgresClient>) {}

  async save(state: ProcessState): Promise<void> {
    const sql = this.client.sql;
    // Pass objects directly - postgres-js handles JSONB serialization
    await sql`
      INSERT INTO process_executions (
        process_id, instance_id, code_version, pc, variables, timers, status,
        result, error, last_error, last_error_at,
        suspended_at, completed_at, created_at, updated_at
      ) VALUES (
        ${state.processId}, ${state.instanceId}, ${state.version}, ${state.pc},
        ${sql.json(state.variables as any)}, ${sql.json(state.timers as any)}, ${state.status},
        ${state.result !== undefined ? sql.json(state.result as any) : null}, ${state.error || null},
        ${state.lastError || null}, ${state.lastErrorAt || null},
        ${state.suspendedAt || null}, ${state.completedAt || null},
        ${state.createdAt || new Date()}, ${new Date()}
      )
      ON CONFLICT (instance_id) DO UPDATE SET
        pc = EXCLUDED.pc,
        variables = EXCLUDED.variables,
        timers = EXCLUDED.timers,
        status = EXCLUDED.status,
        result = EXCLUDED.result,
        error = EXCLUDED.error,
        last_error = EXCLUDED.last_error,
        last_error_at = EXCLUDED.last_error_at,
        suspended_at = EXCLUDED.suspended_at,
        completed_at = EXCLUDED.completed_at,
        updated_at = NOW()
    `;
  }

  async load(instanceId: string): Promise<ProcessState | null> {
    const sql = this.client.sql;
    const [row] = await sql`
      SELECT * FROM process_executions WHERE instance_id = ${instanceId}
    `;
    return row ? this.toProcessState(row) : null;
  }

  async delete(instanceId: string): Promise<void> {
    const sql = this.client.sql;
    await sql`DELETE FROM process_executions WHERE instance_id = ${instanceId}`;
  }

  async complete(instanceId: string, result: unknown): Promise<void> {
    const sql = this.client.sql;
    await sql`
      UPDATE process_executions SET
        status = 'completed',
        result = ${sql.json(result as any)},
        completed_at = NOW(),
        updated_at = NOW()
      WHERE instance_id = ${instanceId}
    `;
  }

  async fail(instanceId: string, error: string): Promise<void> {
    const sql = this.client.sql;
    await sql`
      UPDATE process_executions SET
        status = 'failed',
        error = ${error},
        completed_at = NOW(),
        updated_at = NOW()
      WHERE instance_id = ${instanceId}
    `;
  }

  async *findByProcessId(processId: string): AsyncIterable<ProcessState> {
    const sql = this.client.sql;
    const rows = await sql`
      SELECT * FROM process_executions WHERE process_id = ${processId}
    `;
    for (const row of rows) yield this.toProcessState(row);
  }

  async *findByStatus(status: ProcessStatus): AsyncIterable<ProcessState> {
    const sql = this.client.sql;
    const rows = await sql`
      SELECT * FROM process_executions WHERE status = ${status}
    `;
    for (const row of rows) yield this.toProcessState(row);
  }

  async *findWaitingForSignal(
    signal: string,
    identity: Record<string, string>,
  ): AsyncIterable<ProcessState> {
    const sql = this.client.sql;
    // Query suspended processes and filter by signal in application
    const rows = await sql`
      SELECT * FROM process_executions
      WHERE status = 'suspended'
        AND variables->>'__waitingForSignal' = ${signal}
    `;
    for (const row of rows) {
      const state = this.toProcessState(row);
      const stateIdentity = state.variables.__signalIdentity as
        | Record<string, string>
        | undefined;
      if (!stateIdentity || this.matchesIdentity(stateIdentity, identity)) {
        yield state;
      }
    }
  }

  async *findExpiredTimers(before: Date): AsyncIterable<ProcessState> {
    const sql = this.client.sql;
    const rows = await sql`
      SELECT * FROM process_executions
      WHERE status = 'suspended'
    `;
    for (const row of rows) {
      const state = this.toProcessState(row);
      const hasExpired = state.timers.some(
        (t) => new Date(t.expiresAt) <= before,
      );
      if (hasExpired) yield state;
    }
  }

  private matchesIdentity(
    stateIdentity: Record<string, string>,
    queryIdentity: Record<string, string>,
  ): boolean {
    for (const [key, value] of Object.entries(queryIdentity)) {
      if (stateIdentity[key] !== value) return false;
    }
    return true;
  }

  private toProcessState(row: any): ProcessState {
    return {
      processId: row.process_id,
      instanceId: row.instance_id,
      version: row.code_version,
      pc: row.pc,
      variables: row.variables,
      timers: row.timers,
      status: row.status as ProcessStatus,
      result: row.result,
      error: row.error,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
      suspendedAt: row.suspended_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

import { Config } from '@justscale/core';
import { PostgresProcessConfig } from '../config.js';

/**
 * Service that provides PostgreSQL-backed signal bus.
 * Reads its channel name from `Config.of(PostgresProcessConfig)`.
 */
// Kept as `const defineService(...)` because the factory's declared
// return type `AbstractSignalBus` is an abstract class with abstract
// members - a class-form wrapper would inherit them and become
// non-instantiable (see PostgresClientService above for the same
// reason).
export const PgSignalBusService = defineService({
  inject: {
    config: Config.of(PostgresProcessConfig),
    lifecycle: Lifecycle,
    repo: SignalSubscriptionRepository,
    channelBackend: AbstractChannelBackend,
  },
  factory: async ({ config, lifecycle, repo, channelBackend }): Promise<AbstractSignalBus> => {
    trace('PgSignalBusService', `Creating PgSignalBus with channel: ${config.signalChannel}`);
    const signalBus = new PgSignalBus({
      subscriptionRepo: repo,
      channelBackend,
      channel: config.signalChannel,
    });

    await signalBus.start();

    lifecycle.register('stop', async () => {
      await signalBus.stop();
    });

    return signalBus;
  },
});

/**
 * Postgres-backed durable process runtime.
 *
 * Requires `PostgresProcessConfig` (signal channel name for LISTEN/NOTIFY).
 * Override via env for per-test isolation.
 *
 * @example
 * ```typescript
 * import JustScale from '@justscale/core'
 * import { createPostgresClient, createPostgresChannelBackend, PostgresLockFeature, PostgresProcessFeature } from '@justscale/postgres'
 *
 * JustScale()
 *   .add(createPostgresClient({ connectionString: '...' }))
 *   .add(bindService(AbstractChannelBackend, createPostgresChannelBackend({ connectionString: '...' })))
 *   .add(PostgresLockFeature)
 *   .add(PostgresProcessFeature)
 *   .build()
 * ```
 */
/**
 * Postgres-backed durable process runtime.
 *
 * Config: `PostgresProcessConfig` - signal channel name for LISTEN/NOTIFY.
 * For test isolation, override via env (e.g. a per-test-run channel name).
 */
export const PostgresProcessFeature = createFeatureBuilder()
  .name('PostgresProcess')
  .requires(AbstractPostgresClient)
  .requires(AbstractLockProvider)
  .requires(AbstractChannelBackend)
  .requires(Config.of(PostgresProcessConfig))
  .requires(Lifecycle)
  .provides((b) =>
    b
      .add(ModelChangeChannels)
      .add(SignalSubscriptionRepository)
      .add(PgProcessStorageService)
      .add(bindService(AbstractProcessStorage, PgProcessStorageService))
      .add(PgSignalBusService)
      .add(bindService(AbstractSignalBus, PgSignalBusService))
      .add(ProcessExecutorService)
      .add(bindService(AbstractProcessExecutor, ProcessExecutorService)),
  );
