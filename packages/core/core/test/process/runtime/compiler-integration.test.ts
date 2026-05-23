/**
 * Compiler Integration Tests
 *
 * These tests verify the FULL pipeline:
 * 1. Process file is compiled by @justscale/typescript/register loader
 * 2. Compiled process is executed by ProcessExecutor
 * 3. Signals correctly suspend and resume processes
 *
 * This ensures the ptsc transformation actually produces working code,
 * not just syntactically correct output.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { ProcessExecutor } from '../../../src/runtime/process/executor.js';
import {
  createInMemoryProcessStorage,
  type InMemoryProcessStorageInstance,
} from '../../../src/runtime/process/storage.js';
import { InMemorySignalBus } from '../../../src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../../src/runtime/process/timer-scheduler.js';
import {
  setProcessExecutor,
  type CompiledSwitchProcess,
  type Signal,
} from '../../../src/process/index.js';
import type { ServiceToken, Resolver } from '../../../src/core/index.js';

// Import the REAL process file - this goes through the loader!
import {
  immediateProcess,
  waitForSignalProcess,
  raceProcess,
  SimpleSignals,
} from '../fixtures/simple.process.js';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockResolver = (services: Map<unknown, unknown>): Resolver =>
  (async (token: unknown) => {
    return services.get(token);
  }) as Resolver;

// ============================================================================
// Integration Tests
// ============================================================================

describe('Compiler Integration: Real Process Files', () => {
  let executor: ProcessExecutor;
  let storage: InMemoryProcessStorageInstance;
  let signalBus: InMemorySignalBus;
  let timerScheduler: InMemoryTimerScheduler;
  let signalsService: {
    approved: Signal<[taskId: string], { approver: string }>
    rejected: Signal<[taskId: string], { reason: string }>
  };

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
    signalBus = new InMemorySignalBus();
    timerScheduler = new InMemoryTimerScheduler();

    // Create executor first with empty resolver
    executor = new ProcessExecutor({
      resolve: createMockResolver(new Map()),
      storage,
      signalBus,
      timerScheduler,
    });

    // Create the signals service - it needs the executor
    signalsService = {
      approved: executor.createSignal<[taskId: string], { approver: string }>(
        'simple.approved',
        ['taskId']
      ),
      rejected: executor.createSignal<[taskId: string], { reason: string }>(
        'simple.rejected',
        ['taskId']
      ),
    };

    // Set the global executor so compiled processes can use it
    setProcessExecutor(executor);
  });

  afterEach(() => {
    setProcessExecutor(null);
    timerScheduler.stop();
    timerScheduler.clear();
    signalBus.clear();
    storage.clear();
  });

  describe('Process compilation verification', () => {
    it('compiled process has expected shape', () => {
      // Verify the process was compiled (not just passed through)
      const compiled = (immediateProcess as unknown as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>> }).__compiled;

      assert.ok(compiled, 'Process should have __compiled property');
      assert.ok(compiled.id, 'Compiled process should have id');
      assert.ok(compiled.path, 'Compiled process should have path');
      assert.ok(compiled.execute, 'Compiled process should have execute function');
      assert.ok(compiled.stepMap, 'Compiled process should have stepMap');
      assert.strictEqual(typeof compiled.execute, 'function');
    });
  });

  describe('Immediate process execution', () => {
    it('executes a process that completes immediately', async () => {
      const compiled = (immediateProcess as unknown as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>> }).__compiled;

      const handle = await executor.start(compiled, ['test-123']);
      const result = await handle.wait();

      assert.deepStrictEqual(result, {
        id: 'test-123',
        status: 'completed',
      });

      // Verify state is persisted
      const state = await storage.load('immediate/test-123');
      assert.ok(state);
      assert.strictEqual(state.status, 'completed');
    });
  });

  describe('Signal suspension and resumption', () => {
    it('suspends on signal and resumes when signal is emitted', async () => {
      // Mock the resolver to return our signals service using the actual token
      const serviceMap = new Map<unknown, unknown>();
      serviceMap.set(SimpleSignals, signalsService);

      const executorWithServices = new ProcessExecutor({
        resolve: createMockResolver(serviceMap),
        storage,
        signalBus,
        timerScheduler,
      });
      setProcessExecutor(executorWithServices);

      // Re-create signals with the new executor
      const signalsForThisTest = {
        approved: executorWithServices.createSignal<[taskId: string], { approver: string }>(
          'simple.approved',
          ['taskId']
        ),
        rejected: executorWithServices.createSignal<[taskId: string], { reason: string }>(
          'simple.rejected',
          ['taskId']
        ),
      };
      serviceMap.set(SimpleSignals, signalsForThisTest);

      const compiled = (waitForSignalProcess as unknown as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>> }).__compiled;

      // Start the process - should suspend waiting for signal
      const handle = await executorWithServices.start(compiled, ['task-456']);

      // Verify it's suspended
      const stateBeforeSignal = await storage.load('wait-signal/task-456');
      assert.strictEqual(stateBeforeSignal?.status, 'suspended');

      // Emit the signal
      await executorWithServices.emit(
        'simple.approved',
        { taskId: 'task-456' },
        { approver: 'john.doe' }
      );

      // Process should complete
      const result = await handle.wait();
      assert.deepStrictEqual(result, {
        taskId: 'task-456',
        approved: true,
        approver: 'john.doe',
      });

      // Verify final state
      const stateAfterSignal = await storage.load('wait-signal/task-456');
      assert.strictEqual(stateAfterSignal?.status, 'completed');
    });
  });

  describe('Race pattern', () => {
    it('completes when first race branch wins (approved signal)', async () => {
      const serviceMap = new Map<unknown, unknown>();

      const executorWithServices = new ProcessExecutor({
        resolve: createMockResolver(serviceMap),
        storage,
        signalBus,
        timerScheduler,
      });
      setProcessExecutor(executorWithServices);

      // Create signals bound to this executor
      const signalsForThisTest = {
        approved: executorWithServices.createSignal<[taskId: string], { approver: string }>(
          'simple.approved',
          ['taskId']
        ),
        rejected: executorWithServices.createSignal<[taskId: string], { reason: string }>(
          'simple.rejected',
          ['taskId']
        ),
      };
      serviceMap.set(SimpleSignals, signalsForThisTest);

      const compiled = (raceProcess as unknown as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>> }).__compiled;

      // Start the process
      const handle = await executorWithServices.start(compiled, ['race-task-1']);

      // Verify it's suspended in race
      const state = await storage.load('race/race-task-1');
      assert.strictEqual(state?.status, 'suspended');

      // Emit approved signal - should win the race
      await executorWithServices.emit(
        'simple.approved',
        { taskId: 'race-task-1' },
        { approver: 'alice' }
      );

      const result = await handle.wait();
      assert.deepStrictEqual(result, {
        taskId: 'race-task-1',
        outcome: 'approved',
        approver: 'alice',
      });
    });

    it('completes when rejected signal wins the race', async () => {
      const serviceMap = new Map<unknown, unknown>();

      const executorWithServices = new ProcessExecutor({
        resolve: createMockResolver(serviceMap),
        storage,
        signalBus,
        timerScheduler,
      });
      setProcessExecutor(executorWithServices);

      const signalsForThisTest = {
        approved: executorWithServices.createSignal<[taskId: string], { approver: string }>(
          'simple.approved',
          ['taskId']
        ),
        rejected: executorWithServices.createSignal<[taskId: string], { reason: string }>(
          'simple.rejected',
          ['taskId']
        ),
      };
      serviceMap.set(SimpleSignals, signalsForThisTest);

      const compiled = (raceProcess as unknown as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>> }).__compiled;

      const handle = await executorWithServices.start(compiled, ['race-task-2']);

      // Emit rejected signal instead
      await executorWithServices.emit(
        'simple.rejected',
        { taskId: 'race-task-2' },
        { reason: 'budget exceeded' }
      );

      const result = await handle.wait();
      assert.deepStrictEqual(result, {
        taskId: 'race-task-2',
        outcome: 'rejected',
        reason: 'budget exceeded',
      });
    });

    it('completes when timer wins the race', async () => {
      const serviceMap = new Map<unknown, unknown>();

      const executorWithServices = new ProcessExecutor({
        resolve: createMockResolver(serviceMap),
        storage,
        signalBus,
        timerScheduler,
      });
      setProcessExecutor(executorWithServices);

      const signalsForThisTest = {
        approved: executorWithServices.createSignal<[taskId: string], { approver: string }>(
          'simple.approved',
          ['taskId']
        ),
        rejected: executorWithServices.createSignal<[taskId: string], { reason: string }>(
          'simple.rejected',
          ['taskId']
        ),
      };
      serviceMap.set(SimpleSignals, signalsForThisTest);

      const compiled = (raceProcess as unknown as { __compiled: CompiledSwitchProcess<Record<string, ServiceToken>> }).__compiled;

      const handle = await executorWithServices.start(compiled, ['race-task-3']);

      // Don't emit any signals - let the timer win
      // Fire the timer
      timerScheduler.fireNext();

      const result = await handle.wait();
      assert.deepStrictEqual(result, {
        taskId: 'race-task-3',
        outcome: 'timeout',
      });
    });
  });
});
