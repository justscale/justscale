/**
 * Stream-Process Integration Edge Cases
 *
 * Tests for edge cases in the stream() primitive and signal emission.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ProcessExecutor } from '../../src/runtime/process/executor.js';
import { InMemorySignalBus } from '../../src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../src/runtime/process/timer-scheduler.js';
import { createInMemoryProcessStorage } from '../../src/runtime/process/storage.js';

describe('Stream-Process Edge Cases', () => {
  describe('Wildcard Resolution', () => {
    let executor: ProcessExecutor;

    beforeEach(() => {
      executor = new ProcessExecutor({
        resolve: async () => undefined as never,
        storage: createInMemoryProcessStorage(),
        signalBus: new InMemorySignalBus(),
        timerScheduler: new InMemoryTimerScheduler(),
      });
    });

    // Access private method for testing
    function resolveStreamWildcard(
      signalName: string,
      identity: Record<string, string>
    ): string {
      return (executor as any).resolveStreamWildcard(signalName, identity);
    }

    describe('standard model names', () => {
      it('resolves Order -> orderRef', () => {
        const result = resolveStreamWildcard(
          'stream:Order:*:statusUpdates',
          { orderRef: 'order-123' }
        );
        assert.strictEqual(result, 'stream:Order:order-123:statusUpdates');
      });

      it('resolves User -> userRef', () => {
        const result = resolveStreamWildcard(
          'stream:User:*:notifications',
          { userRef: 'user-456' }
        );
        assert.strictEqual(result, 'stream:User:user-456:notifications');
      });

      it('resolves OrderItem -> orderItemRef (multi-word)', () => {
        const result = resolveStreamWildcard(
          'stream:OrderItem:*:changes',
          { orderItemRef: 'item-789' }
        );
        assert.strictEqual(result, 'stream:OrderItem:item-789:changes');
      });
    });

    describe('acronym and unusual model names', () => {
      it('handles single letter model name A -> aRef', () => {
        const result = resolveStreamWildcard(
          'stream:A:*:events',
          { aRef: 'a-123' }
        );
        assert.strictEqual(result, 'stream:A:a-123:events');
      });

      it('handles acronym model ABC -> abcRef (proper camelCase)', () => {
        // Acronyms are properly converted: ABC -> abcRef (all lowercase)
        const result = resolveStreamWildcard(
          'stream:ABC:*:events',
          { abcRef: 'abc-123' }
        );
        assert.strictEqual(result, 'stream:ABC:abc-123:events');
      });

      it('handles HTTPServer -> httpServerRef', () => {
        // Acronym prefix: HTTPServer -> httpServerRef
        const result = resolveStreamWildcard(
          'stream:HTTPServer:*:logs',
          { httpServerRef: 'srv-456' }
        );
        assert.strictEqual(result, 'stream:HTTPServer:srv-456:logs');
      });

      it('falls back to any *Id key when primary not found', () => {
        // When orderRef doesn't match, should try fallback
        const result = resolveStreamWildcard(
          'stream:Order:*:updates',
          { id: 'order-123' } // No 'orderRef', but has 'id'
        );
        assert.strictEqual(result, 'stream:Order:order-123:updates');
      });

      it('falls back to entityId when primary not found', () => {
        const result = resolveStreamWildcard(
          'stream:Order:*:updates',
          { entityId: 'order-456' }
        );
        assert.strictEqual(result, 'stream:Order:order-456:updates');
      });
    });

    describe('multi-parameter identity', () => {
      it('uses correct parameter for nested paths', () => {
        // Path: /user/:userRef/order/:orderRef
        // Stream on Order model
        const result = resolveStreamWildcard(
          'stream:Order:*:events',
          { userRef: 'user-123', orderRef: 'order-456' }
        );
        assert.strictEqual(result, 'stream:Order:order-456:events');
      });

      it('prioritizes model-specific key over generic id', () => {
        const result = resolveStreamWildcard(
          'stream:Order:*:events',
          { id: 'wrong-id', orderRef: 'correct-order-id' }
        );
        assert.strictEqual(result, 'stream:Order:correct-order-id:events');
      });
    });

    describe('non-wildcard signals', () => {
      it('returns unchanged if no wildcard', () => {
        const result = resolveStreamWildcard(
          'stream:Order:order-123:events',
          { orderRef: 'different-id' }
        );
        // Should return unchanged - no wildcard to resolve
        assert.strictEqual(result, 'stream:Order:order-123:events');
      });

      it('returns unchanged for non-stream signals', () => {
        const result = resolveStreamWildcard(
          'orders.completed',
          { orderRef: 'order-123' }
        );
        assert.strictEqual(result, 'orders.completed');
      });
    });

    describe('missing identity', () => {
      it('uses any *Ref key as fallback when primary not found', () => {
        // customerRef ends with 'Ref', so fallback uses it
        const result = resolveStreamWildcard(
          'stream:Order:*:events',
          { customerRef: 'cust-123' } // No orderRef, but customerRef works as fallback
        );
        // Fallback finds customerRef and uses its value
        assert.strictEqual(result, 'stream:Order:cust-123:events');
      });

      it('handles empty identity object', () => {
        const result = resolveStreamWildcard(
          'stream:Order:*:events',
          {}
        );
        // No fallback available - returns unresolved
        assert.strictEqual(result, 'stream:Order:*:events');
      });

      it('returns unresolved when no *Ref, *Id, or id keys exist', () => {
        const result = resolveStreamWildcard(
          'stream:Order:*:events',
          { name: 'test', value: '123' } // No keys ending in 'Ref'/'Id' or equal to 'ref'/'id'
        );
        // Current behavior: returns unresolved wildcard
        // This is problematic - signal will never match
        assert.strictEqual(result, 'stream:Order:*:events');
      });
    });

    describe('signal name format edge cases', () => {
      it('handles field names with underscores', () => {
        const result = resolveStreamWildcard(
          'stream:Order:*:status_updates',
          { orderRef: 'order-123' }
        );
        assert.strictEqual(result, 'stream:Order:order-123:status_updates');
      });

      it('handles model names with numbers', () => {
        const result = resolveStreamWildcard(
          'stream:V2Order:*:events',
          { v2OrderRef: 'v2-123' }
        );
        assert.strictEqual(result, 'stream:V2Order:v2-123:events');
      });
    });
  });

  describe('Signal Bus Stream Integration', () => {
    let signalBus: InMemorySignalBus;

    beforeEach(() => {
      signalBus = new InMemorySignalBus();
    });

    it('matches stream signal with exact name', async () => {
      let matchedPayload: unknown = null;

      // Subscribe to resolved stream signal
      signalBus.subscribe(
        'instance-1',
        'stream:Order:order-123:statusUpdates',
        { orderRef: 'order-123' }
      );

      signalBus.onMatch((match) => {
        matchedPayload = match.payload;
      });

      // Emit stream signal
      const count = await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderRef: 'order-123' },
        { status: 'shipped' }
      );

      assert.strictEqual(count, 1);
      assert.deepStrictEqual(matchedPayload, { status: 'shipped' });
    });

    it('does not match when entity ID differs', async () => {
      signalBus.subscribe(
        'instance-1',
        'stream:Order:order-123:statusUpdates',
        { orderRef: 'order-123' }
      );

      // Emit for different entity
      const count = await signalBus.emit(
        'stream:Order:order-456:statusUpdates',
        { orderRef: 'order-456' },
        { status: 'shipped' }
      );

      assert.strictEqual(count, 0);
    });

    it('handles multiple processes on same stream', async () => {
      const matches: string[] = [];

      signalBus.subscribe(
        'instance-1',
        'stream:Order:order-123:statusUpdates',
        { orderRef: 'order-123' }
      );
      signalBus.subscribe(
        'instance-2',
        'stream:Order:order-123:statusUpdates',
        { orderRef: 'order-123' }
      );

      signalBus.onMatch((match) => {
        matches.push(match.instanceId);
      });

      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderRef: 'order-123' },
        { status: 'shipped' }
      );

      // Both should be matched
      assert.strictEqual(matches.length, 2);
      assert.ok(matches.includes('instance-1'));
      assert.ok(matches.includes('instance-2'));
    });

    it('handles race between stream and signal branches', async () => {
      let winningBranch: string | null = null;

      const subId = await signalBus.subscribeRace('instance-1', [
        {
          branchId: 'stream-branch',
          signal: 'stream:Order:order-123:statusUpdates',
          identity: { orderRef: 'order-123' },
        },
        {
          branchId: 'signal-branch',
          signal: 'orders.cancelled',
          identity: { orderRef: 'order-123' },
        },
      ]);

      signalBus.onMatch((match) => {
        winningBranch = match.branchId ?? null;
      });

      // Stream wins the race
      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderRef: 'order-123' },
        { status: 'shipped' }
      );

      assert.strictEqual(winningBranch, 'stream-branch');
    });

    it('handles race between stream and delay', async () => {
      let matchReceived = false;

      await signalBus.subscribeRace('instance-1', [
        {
          branchId: 'stream-branch',
          signal: 'stream:Order:order-123:statusUpdates',
          identity: { orderRef: 'order-123' },
        },
        {
          branchId: 'timer-branch',
          expiresAt: new Date(Date.now() + 1000), // 1 second in future
        },
      ]);

      signalBus.onMatch(() => {
        matchReceived = true;
      });

      // Stream fires before timer expires
      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderRef: 'order-123' },
        { status: 'shipped' }
      );

      assert.ok(matchReceived, 'Stream branch should have won');
    });
  });

  describe('Concurrent Operations', () => {
    let signalBus: InMemorySignalBus;

    beforeEach(() => {
      signalBus = new InMemorySignalBus();
    });

    it('handles rapid sequential publishes', async () => {
      const payloads: unknown[] = [];

      signalBus.subscribe(
        'instance-1',
        'stream:Order:order-123:updates',
        { orderRef: 'order-123' }
      );

      signalBus.onMatch((match) => {
        payloads.push(match.payload);
      });

      // Rapid sequential publishes
      await signalBus.emit(
        'stream:Order:order-123:updates',
        { orderRef: 'order-123' },
        { seq: 1 }
      );
      await signalBus.emit(
        'stream:Order:order-123:updates',
        { orderRef: 'order-123' },
        { seq: 2 }
      );
      await signalBus.emit(
        'stream:Order:order-123:updates',
        { orderRef: 'order-123' },
        { seq: 3 }
      );

      // First emit removes subscription, subsequent emits have no effect
      assert.strictEqual(payloads.length, 1);
      assert.deepStrictEqual(payloads[0], { seq: 1 });
    });

    it('handles publish before subscribe (no match)', async () => {
      let matchReceived = false;

      // Publish first
      await signalBus.emit(
        'stream:Order:order-123:updates',
        { orderRef: 'order-123' },
        { status: 'shipped' }
      );

      // Then subscribe
      signalBus.subscribe(
        'instance-1',
        'stream:Order:order-123:updates',
        { orderRef: 'order-123' }
      );

      signalBus.onMatch(() => {
        matchReceived = true;
      });

      // Signal was already emitted before subscription
      assert.ok(!matchReceived, 'Should not receive signal published before subscription');
    });
  });
});
