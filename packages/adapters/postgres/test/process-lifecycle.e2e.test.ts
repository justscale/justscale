/**
 * E2E tests for durable process lifecycle with real PostgreSQL storage.
 *
 * Exercises: ProcessExecutor + PgProcessStorage (raw SQL) + InMemorySignalBus.
 * Hand-written execute functions mirror compiled switch output.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { requirePostgres, createTestDatabase, type TestDatabase } from './__mocks__/test-setup.js';
import {
  ProcessExecutor,
} from '@justscale/core/process';
import { InMemorySignalBus } from '../../../core/core/src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../../core/core/src/runtime/process/timer-scheduler.js';
import type { ProcessStorage } from '../../../core/core/src/runtime/process/storage.js';
import type { CompiledSwitchProcess, ExecutionContext, ExecutionResult } from '../../../core/core/src/process/types.js';
import { DONE, SUSPEND } from '../../../core/core/src/process/types.js';
import type { ServiceToken, Resolver } from '../../../core/core/src/core/index.js';

// ============================================================================
// Helpers
// ============================================================================

const createMockResolver = (): Resolver =>
  (async () => undefined) as Resolver;

const createSwitchProcess = (
  overrides: Partial<CompiledSwitchProcess<Record<string, ServiceToken>>> & {
    execute: (ctx: ExecutionContext) => Promise<ExecutionResult>
  }
): CompiledSwitchProcess<Record<string, ServiceToken>> => ({
  id: overrides.id ?? 'test-process',
  path: overrides.path ?? '/test/:testId',
  version: '1.0.0',
  inject: {},
  stepMap: { entry: 0 },
  sourceMap: {},
  signals: {},
  ...overrides,
});

/**
 * Minimal ProcessStorage implementation backed by raw postgres SQL.
 * Matches PgProcessStorageImpl semantics without DI overhead.
 */
function createPgStorage(sql: ReturnType<typeof postgres>): ProcessStorage {
  return {
    async save(state) {
      await sql`
        INSERT INTO process_executions (
          process_id, instance_id, code_version, pc, variables, timers, status,
          result, error, suspended_at, completed_at, created_at, updated_at
        ) VALUES (
          ${state.processId}, ${state.instanceId}, ${state.version}, ${state.pc},
          ${sql.json(state.variables as any)}, ${sql.json(state.timers as any)}, ${state.status},
          ${state.result !== undefined ? sql.json(state.result as any) : null}, ${state.error || null},
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
          suspended_at = EXCLUDED.suspended_at,
          completed_at = EXCLUDED.completed_at,
          updated_at = NOW()
      `;
    },

    async load(instanceId) {
      const [row] = await sql`
        SELECT * FROM process_executions WHERE instance_id = ${instanceId}
      `;
      return row ? toState(row) : null;
    },

    async delete(instanceId) {
      await sql`DELETE FROM process_executions WHERE instance_id = ${instanceId}`;
    },

    async complete(instanceId, result) {
      await sql`
        UPDATE process_executions SET
          status = 'completed',
          result = ${sql.json(result as any)},
          completed_at = NOW(),
          updated_at = NOW()
        WHERE instance_id = ${instanceId}
      `;
    },

    async fail(instanceId, error) {
      await sql`
        UPDATE process_executions SET
          status = 'failed',
          error = ${error},
          completed_at = NOW(),
          updated_at = NOW()
        WHERE instance_id = ${instanceId}
      `;
    },

    async *findByProcessId(processId) {
      const rows = await sql`SELECT * FROM process_executions WHERE process_id = ${processId}`;
      for (const row of rows) yield toState(row);
    },

    async *findByStatus(status) {
      const rows = await sql`SELECT * FROM process_executions WHERE status = ${status}`;
      for (const row of rows) yield toState(row);
    },

    async *findWaitingForSignal(signal, identity) {
      const rows = await sql`
        SELECT * FROM process_executions
        WHERE status = 'suspended'
          AND variables->>'__waitingForSignal' = ${signal}
      `;
      for (const row of rows) {
        const state = toState(row);
        const stateIdentity = state.variables.__signalIdentity as Record<string, string> | undefined;
        if (!stateIdentity) { yield state; continue; }
        let matches = true;
        for (const [key, value] of Object.entries(identity)) {
          if (stateIdentity[key] !== value) { matches = false; break; }
        }
        if (matches) yield state;
      }
    },

    async *findExpiredTimers(before) {
      const rows = await sql`SELECT * FROM process_executions WHERE status = 'suspended'`;
      for (const row of rows) {
        const state = toState(row);
        if (state.timers.some((t: any) => new Date(t.expiresAt) <= before)) yield state;
      }
    },
  };
}

function toState(row: any) {
  return {
    processId: row.process_id,
    instanceId: row.instance_id,
    version: row.code_version,
    pc: row.pc,
    variables: row.variables,
    timers: row.timers,
    status: row.status,
    result: row.result,
    error: row.error,
    suspendedAt: row.suspended_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Process Lifecycle E2E (PostgreSQL)', async () => {
  if (!await requirePostgres()) return;

  let db: TestDatabase;
  let sql: ReturnType<typeof postgres>;
  let storage: ProcessStorage;

  before(async () => {
    db = await createTestDatabase('process_lifecycle');
    sql = postgres(db.connectionString);
    await sql`
      CREATE TABLE process_executions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        process_id VARCHAR(255) NOT NULL,
        instance_id VARCHAR(512) NOT NULL UNIQUE,
        code_version VARCHAR(64) NOT NULL DEFAULT '',
        pc INTEGER NOT NULL DEFAULT 0,
        variables JSONB NOT NULL DEFAULT '{}',
        timers JSONB NOT NULL DEFAULT '[]',
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        result JSONB,
        error TEXT,
        suspended_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        version INTEGER NOT NULL DEFAULT 1
      )
    `;
    storage = createPgStorage(sql);
  });

  after(async () => {
    await sql.end();
    await db.drop();
  });

  // Helper: create fresh executor per test
  function createExecutor() {
    const signalBus = new InMemorySignalBus();
    const timerScheduler = new InMemoryTimerScheduler();
    const executor = new ProcessExecutor({
      resolve: createMockResolver(),
      storage,
      signalBus,
      timerScheduler,
    });
    return { executor, signalBus, timerScheduler };
  }

  // Clean table between tests
  async function truncate() {
    await sql`TRUNCATE process_executions`;
  }

  // ============================================================================
  // 1. Basic signal suspend/resume
  // ============================================================================

  it('basic signal suspend/resume via postgres', async () => {
    await truncate();
    const { executor } = createExecutor();
    const collected: string[] = [];

    const proc = createSwitchProcess({
      id: 'basic-sig',
      path: '/basic/:testId',
      stepMap: { entry: 0, resume: 1, done: 2 },
      signals: { 'test.proceed': { identity: ['testId'], payloadType: 'unknown' } },
      execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
        const state = ctx.state;
        const vars = state.vars as Record<string, unknown>;

        // biome-ignore lint/correctness/noConstantCondition: mirrors compiled
        while (true) {
          switch (state.step) {
            case 0: {
              collected.push('step-0');
              vars.counter = 1;
              state.step = 1;
              return [SUSPEND, { race: [{ id: 'signal_0', signal: 'test.proceed', resumeStep: 1 }] }];
            }
            case 1: {
              collected.push('step-1');
              vars.counter = (vars.counter as number) + 1;
              state.step = 2;
              continue;
            }
            case 2: {
              return [DONE, { counter: vars.counter, items: collected }];
            }
            default: throw new Error(`Unexpected step: ${state.step}`);
          }
        }
      },
    });

    await executor.start(proc, ['sig-1']);
    assert.deepStrictEqual(collected, ['step-0']);

    // Verify suspended in DB
    const [row] = await sql`SELECT * FROM process_executions WHERE instance_id = 'basic/sig-1'`;
    assert.ok(row, 'Row should exist in DB');
    assert.strictEqual(row.status, 'suspended');
    assert.strictEqual(row.variables.counter, 1);

    // Emit signal -> resume -> complete
    await executor.emit('test.proceed', { testId: 'sig-1' }, {});
    assert.deepStrictEqual(collected, ['step-0', 'step-1']);

    // Verify completed in DB
    const [completedRow] = await sql`SELECT * FROM process_executions WHERE instance_id = 'basic/sig-1'`;
    assert.strictEqual(completedRow.status, 'completed');
    assert.deepStrictEqual(completedRow.result, { counter: 2, items: ['step-0', 'step-1'] });
  });

  // ============================================================================
  // 2. Race pattern with timer
  // ============================================================================

  it('race pattern: signal wins over delay', async () => {
    await truncate();
    const { executor } = createExecutor();

    const proc = createSwitchProcess({
      id: 'race-sig',
      path: '/race/:testId',
      stepMap: { entry: 0, signalBranch: 1, timerBranch: 2, done: 3 },
      signals: { 'race.payment': { identity: ['testId'], payloadType: 'unknown' } },
      execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
        const state = ctx.state;
        const vars = state.vars as Record<string, unknown>;

        // biome-ignore lint/correctness/noConstantCondition: mirrors compiled
        while (true) {
          switch (state.step) {
            case 0: {
              vars.phase = 'waiting';
              return [SUSPEND, {
                race: [
                  { id: 'signal_0', signal: 'race.payment', resumeStep: 1 },
                  { id: 'timer_0', timer: { days: 3 }, resumeStep: 2 },
                ],
              }];
            }
            case 1: {
              // Signal branch won
              vars.phase = 'paid';
              vars.payload = vars.__raceResult;
              state.step = 3;
              continue;
            }
            case 2: {
              // Timer branch won
              vars.phase = 'timeout';
              state.step = 3;
              continue;
            }
            case 3: {
              return [DONE, { phase: vars.phase, payload: vars.payload }];
            }
            default: throw new Error(`Unexpected step: ${state.step}`);
          }
        }
      },
    });

    await executor.start(proc, ['race-1']);

    // Verify suspended in DB
    const [row] = await sql`SELECT * FROM process_executions WHERE instance_id = 'race/race-1'`;
    assert.strictEqual(row.status, 'suspended');
    assert.strictEqual(row.variables.phase, 'waiting');

    // Fire signal -> signal branch wins
    await executor.emit('race.payment', { testId: 'race-1' }, { txId: 'tx-999' });

    // Verify completed in DB
    const [completed] = await sql`SELECT * FROM process_executions WHERE instance_id = 'race/race-1'`;
    assert.strictEqual(completed.status, 'completed');
    assert.strictEqual(completed.result.phase, 'paid');
    assert.deepStrictEqual(completed.result.payload, { txId: 'tx-999' });
  });

  // ============================================================================
  // 3. Signal.all (parallel) via postgres
  // ============================================================================

  it('signal.all: parallel signals collect before resume', async () => {
    await truncate();
    const { executor } = createExecutor();

    const proc = createSwitchProcess({
      id: 'parallel-sig',
      path: '/parallel/:testId',
      stepMap: { entry: 0, collect: 1, done: 2 },
      signals: {
        'par.alpha': { identity: ['testId'], payloadType: 'unknown' },
        'par.beta': { identity: ['testId'], payloadType: 'unknown' },
      },
      execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
        const state = ctx.state;
        const vars = state.vars as Record<string, unknown>;

        // biome-ignore lint/correctness/noConstantCondition: mirrors compiled
        while (true) {
          switch (state.step) {
            case 0: {
              // PARALLEL_WAIT: init parallel state, set step to collect (1), suspend
              vars.__parallel_0 = { pending: 2, results: [undefined, undefined], errors: [], isSettled: false };
              state.step = 1; // point to PARALLEL_COLLECT step on resume
              return [SUSPEND, {
                parallel: {
                  parallelId: 0,
                  pending: 2,
                  results: [undefined, undefined],
                  errors: [],
                  isSettled: false,
                  branches: [
                    { id: 0, type: 'signal' as const, expr: { signalName: 'par.alpha' } },
                    { id: 1, type: 'signal' as const, expr: { signalName: 'par.beta' } },
                  ],
                },
              }];
            }
            case 1: {
              // PARALLEL_COLLECT: read results from parallel state
              const parallelState = vars.__parallel_0 as { results: unknown[] };
              vars.collected = parallelState.results;
              state.step = 2;
              continue;
            }
            case 2: {
              return [DONE, { collected: vars.collected }];
            }
            default: throw new Error(`Unexpected step: ${state.step}`);
          }
        }
      },
    });

    await executor.start(proc, ['par-1']);

    // Verify suspended
    const [row1] = await sql`SELECT * FROM process_executions WHERE instance_id = 'parallel/par-1'`;
    assert.strictEqual(row1.status, 'suspended');

    // Fire first signal -> still suspended (pending=1)
    await executor.emit('par.alpha', { testId: 'par-1' }, { a: 1 });

    const [row2] = await sql`SELECT * FROM process_executions WHERE instance_id = 'parallel/par-1'`;
    assert.strictEqual(row2.status, 'suspended');
    assert.strictEqual(row2.variables.__parallel_0.pending, 1);
    assert.deepStrictEqual(row2.variables.__parallel_0.results[0], { a: 1 });

    // Fire second signal -> resumes, completes
    await executor.emit('par.beta', { testId: 'par-1' }, { b: 2 });

    const [row3] = await sql`SELECT * FROM process_executions WHERE instance_id = 'parallel/par-1'`;
    assert.strictEqual(row3.status, 'completed');
    assert.deepStrictEqual(row3.result.collected, [{ a: 1 }, { b: 2 }]);
  });

  // ============================================================================
  // 4. Process state survives executor restart
  // ============================================================================

  it('process state survives executor restart', async () => {
    await truncate();
    const collected: string[] = [];

    // Shared execute fn (closure captures collected array)
    const makeProcess = () => createSwitchProcess({
      id: 'restart-sig',
      path: '/restart/:testId',
      stepMap: { entry: 0, resume: 1, done: 2 },
      signals: { 'restart.go': { identity: ['testId'], payloadType: 'unknown' } },
      execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
        const state = ctx.state;
        const vars = state.vars as Record<string, unknown>;

        // biome-ignore lint/correctness/noConstantCondition: mirrors compiled
        while (true) {
          switch (state.step) {
            case 0: {
              collected.push('started');
              vars.data = 'persisted-value';
              state.step = 1;
              return [SUSPEND, { race: [{ id: 'signal_0', signal: 'restart.go', resumeStep: 1 }] }];
            }
            case 1: {
              collected.push('resumed');
              // Verify variable was restored from DB
              assert.strictEqual(vars.data, 'persisted-value');
              state.step = 2;
              continue;
            }
            case 2: {
              return [DONE, { data: vars.data }];
            }
            default: throw new Error(`Unexpected step: ${state.step}`);
          }
        }
      },
    });

    // Executor 1: start process, suspends
    const exec1 = createExecutor();
    const proc1 = makeProcess();
    await exec1.executor.start(proc1, ['rs-1']);
    assert.deepStrictEqual(collected, ['started']);

    // Verify suspended in DB
    const [row] = await sql`SELECT * FROM process_executions WHERE instance_id = 'restart/rs-1'`;
    assert.strictEqual(row.status, 'suspended');

    // Executor 2 (simulating restart): same storage, fresh in-memory state
    const exec2 = createExecutor();
    const proc2 = makeProcess();

    // Re-register and "start" (which detects existing suspended state and re-subscribes)
    await exec2.executor.start(proc2, ['rs-1']);

    // Now emit through executor 2
    await exec2.executor.emit('restart.go', { testId: 'rs-1' }, {});
    assert.deepStrictEqual(collected, ['started', 'resumed']);

    // Verify completed in DB
    const [completed] = await sql`SELECT * FROM process_executions WHERE instance_id = 'restart/rs-1'`;
    assert.strictEqual(completed.status, 'completed');
    assert.strictEqual(completed.result.data, 'persisted-value');
  });

  // ============================================================================
  // 5. Multiple concurrent process instances
  // ============================================================================

  it('multiple concurrent instances complete independently', async () => {
    await truncate();
    const { executor } = createExecutor();
    const results: Record<string, string> = {};

    const proc = createSwitchProcess({
      id: 'multi-sig',
      path: '/multi/:testId',
      stepMap: { entry: 0, resume: 1, done: 2 },
      signals: { 'multi.go': { identity: ['testId'], payloadType: 'unknown' } },
      execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
        const state = ctx.state;
        const vars = state.vars as Record<string, unknown>;

        // biome-ignore lint/correctness/noConstantCondition: mirrors compiled
        while (true) {
          switch (state.step) {
            case 0: {
              vars.label = `instance-${vars.testId}`;
              state.step = 1;
              return [SUSPEND, { race: [{ id: 'signal_0', signal: 'multi.go', resumeStep: 1 }] }];
            }
            case 1: {
              results[vars.testId as string] = vars.label as string;
              state.step = 2;
              continue;
            }
            case 2: {
              return [DONE, { label: vars.label }];
            }
            default: throw new Error(`Unexpected step: ${state.step}`);
          }
        }
      },
    });

    // Start 3 instances
    await executor.start(proc, ['A']);
    await executor.start(proc, ['B']);
    await executor.start(proc, ['C']);

    // Verify all 3 suspended
    const rows = await sql`SELECT instance_id, status FROM process_executions ORDER BY instance_id`;
    assert.strictEqual(rows.length, 3);
    assert.ok(rows.every(r => r.status === 'suspended'));

    // Fire signals in reverse order
    await executor.emit('multi.go', { testId: 'C' }, {});
    await executor.emit('multi.go', { testId: 'A' }, {});
    await executor.emit('multi.go', { testId: 'B' }, {});

    // Verify all completed
    const completed = await sql`SELECT instance_id, status, result FROM process_executions ORDER BY instance_id`;
    assert.strictEqual(completed.length, 3);
    assert.ok(completed.every(r => r.status === 'completed'));
    assert.strictEqual(completed[0].result.label, 'instance-A');
    assert.strictEqual(completed[1].result.label, 'instance-B');
    assert.strictEqual(completed[2].result.label, 'instance-C');
  });

  // ============================================================================
  // 6. Variable persistence round-trip
  // ============================================================================

  it('variable persistence round-trip: string, number, object, array', async () => {
    await truncate();
    const { executor } = createExecutor();
    let restored: Record<string, unknown> = {};

    const proc = createSwitchProcess({
      id: 'vars-sig',
      path: '/vars/:testId',
      stepMap: { entry: 0, resume: 1, done: 2 },
      signals: { 'vars.go': { identity: ['testId'], payloadType: 'unknown' } },
      execute: async (ctx: ExecutionContext): Promise<ExecutionResult> => {
        const state = ctx.state;
        const vars = state.vars as Record<string, unknown>;

        // biome-ignore lint/correctness/noConstantCondition: mirrors compiled
        while (true) {
          switch (state.step) {
            case 0: {
              vars.myString = 'hello world';
              vars.myNumber = 42.5;
              vars.myObject = { nested: { deep: true }, items: [1, 2, 3] };
              vars.myArray = ['a', 'b', { c: 'c' }];
              vars.myNull = null;
              vars.myBool = true;
              state.step = 1;
              return [SUSPEND, { race: [{ id: 'signal_0', signal: 'vars.go', resumeStep: 1 }] }];
            }
            case 1: {
              // Capture the vars after resume (restored from DB)
              restored = {
                myString: vars.myString,
                myNumber: vars.myNumber,
                myObject: vars.myObject,
                myArray: vars.myArray,
                myNull: vars.myNull,
                myBool: vars.myBool,
              };
              state.step = 2;
              continue;
            }
            case 2: {
              return [DONE, restored];
            }
            default: throw new Error(`Unexpected step: ${state.step}`);
          }
        }
      },
    });

    await executor.start(proc, ['v-1']);

    // Verify JSONB persisted correctly
    const [row] = await sql`SELECT variables FROM process_executions WHERE instance_id = 'vars/v-1'`;
    assert.strictEqual(row.variables.myString, 'hello world');
    assert.strictEqual(row.variables.myNumber, 42.5);
    assert.deepStrictEqual(row.variables.myObject, { nested: { deep: true }, items: [1, 2, 3] });
    assert.deepStrictEqual(row.variables.myArray, ['a', 'b', { c: 'c' }]);
    assert.strictEqual(row.variables.myNull, null);
    assert.strictEqual(row.variables.myBool, true);

    // Resume -> vars restored correctly
    await executor.emit('vars.go', { testId: 'v-1' }, {});

    assert.strictEqual(restored.myString, 'hello world');
    assert.strictEqual(restored.myNumber, 42.5);
    assert.deepStrictEqual(restored.myObject, { nested: { deep: true }, items: [1, 2, 3] });
    assert.deepStrictEqual(restored.myArray, ['a', 'b', { c: 'c' }]);
    assert.strictEqual(restored.myNull, null);
    assert.strictEqual(restored.myBool, true);

    // Verify final result in DB
    const [completed] = await sql`SELECT * FROM process_executions WHERE instance_id = 'vars/v-1'`;
    assert.strictEqual(completed.status, 'completed');
    assert.strictEqual(completed.result.myNumber, 42.5);
  });
});
