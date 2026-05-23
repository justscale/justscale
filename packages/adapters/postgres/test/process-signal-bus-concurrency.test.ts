/**
 * PgSignalBus optimistic-concurrency regression.
 *
 * Pre-fix the queueing path was a blind read-modify-write:
 *   const fresh = await repo.get(sub);
 *   const queued = [...fresh.queuedPayloads, newPayload];
 *   await repo.update(fresh, { queuedPayloads: queued });
 *
 * Two concurrent emit() calls on the same matched subscription would:
 *   - both read baseline []
 *   - both push their payload
 *   - both write [their payload]
 * Last writer silently wins, the other payload is lost.
 *
 * The fix passes versionOf(fresh) as expectedVersion to repo.update so
 * stale writes throw, then retries with backoff + jitter (5 attempts).
 *
 * This test mocks the repository to deterministically reproduce the
 * version-conflict shape and asserts the retry path actually fires.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTER_KEY } from '@justscale/core/models';
import { PgSignalBus, SignalSubscription } from '../src/process/process-signal-bus.js';
import { PG_VERSION } from '../src/repository/pg-repository.js';
import type { Repository } from '../src/repository/pg-repository-service.js';

interface FakeSub {
  [ADAPTER_KEY]: string
  [PG_VERSION]: number
  instanceId: string
  type: string
  signal?: string
  identity: Record<string, string>
  branches?: unknown[]
  status: string
  queuedPayloads: unknown[]
}

function makeMatchedSub(version: number, queuedPayloads: unknown[] = []): FakeSub {
  return {
    [ADAPTER_KEY]: 'sub-1',
    [PG_VERSION]: version,
    instanceId: 'inst-1',
    type: 'race',
    identity: { id: 'X' },
    branches: [{ branchId: 'b-0', signal: 'go', identity: { id: 'X' } }],
    status: 'matched',
    queuedPayloads,
  };
}

/**
 * Build a mock repo whose update() simulates optimistic-concurrency
 * conflicts. The first N update calls reject as "stale write"; the
 * (N+1)th succeeds and bumps the row's version. get() always returns
 * the latest mutable state.
 */
function buildOcRepo(rejectCount: number) {
  let row = makeMatchedSub(0);
  let getCalls = 0;
  let updateCalls = 0;

  const repo: Repository<SignalSubscription> = {
    async get() {
      getCalls++;
      // Return a snapshot so subsequent mutations don't bleed.
      return { ...row, queuedPayloads: [...row.queuedPayloads] } as unknown as SignalSubscription;
    },
    async update(_ref: unknown, data: Partial<{ queuedPayloads: unknown[] }>, expectedVersion?: number) {
      updateCalls++;
      if (updateCalls <= rejectCount) {
        throw new Error('Stale write: entity sub-1 version mismatch');
      }
      // Real ModelRepository checks expectedVersion against current row.
      // Here we trust that the call site passed the version it just read.
      if (expectedVersion !== undefined && expectedVersion !== row[PG_VERSION]) {
        throw new Error('Stale write: entity sub-1 version mismatch');
      }
      row = { ...row, ...data, [PG_VERSION]: row[PG_VERSION] + 1 };
      return row as unknown as SignalSubscription;
    },
    // The fields below aren't exercised by the queue path; satisfy the type.
    async find() { return [row as unknown as SignalSubscription]; },
    async findOne() { return undefined; },
    async insert() { throw new Error('not used'); },
    async delete() {},
    async lock() { return null; },
    async count() { return 1; },
    async exists() { return true; },
    async aggregate() { return null; },
    save() { throw new Error('not used'); },
  } as unknown as Repository<SignalSubscription>;

  return {
    repo,
    getRow: () => row,
    counts: () => ({ getCalls, updateCalls }),
  };
}

describe('PgSignalBus emit queueing — optimistic concurrency', () => {
  it('first attempt succeeds: payload is queued, no retry', async () => {
    const { repo, getRow, counts } = buildOcRepo(/* rejectCount */ 0);
    const bus = new PgSignalBus({ subscriptionRepo: repo });
    // Bypass the channelBackend / start() — we exercise emit() directly.

    const matched = await bus.emit('go', { id: 'X' }, { n: 1 });
    assert.strictEqual(matched, 1, 'should report 1 matched subscription');
    assert.deepStrictEqual(getRow().queuedPayloads, [
      { signal: 'go', identity: { id: 'X' }, payload: { n: 1 }, branchId: 'b-0' },
    ]);
    assert.deepStrictEqual(counts(), { getCalls: 1, updateCalls: 1 });
  });

  it('retries on stale-write rejection, eventually queues the payload', async () => {
    // Reject the first 2 update attempts, succeed on the 3rd.
    const { repo, getRow, counts } = buildOcRepo(/* rejectCount */ 2);
    const bus = new PgSignalBus({ subscriptionRepo: repo });

    const matched = await bus.emit('go', { id: 'X' }, { n: 1 });
    assert.strictEqual(matched, 1, 'payload should land after retries');
    assert.deepStrictEqual(getRow().queuedPayloads, [
      { signal: 'go', identity: { id: 'X' }, payload: { n: 1 }, branchId: 'b-0' },
    ]);
    // 3 attempts means 3 get() + 3 update() calls.
    assert.deepStrictEqual(counts(), { getCalls: 3, updateCalls: 3 });
  });

  it('gives up after MAX_ATTEMPTS without crashing', async () => {
    // Reject every update — after the cap, emit returns gracefully (the
    // waiting-subscription path below would still pick it up live; this
    // queue path is best-effort for mid-processing subs).
    const { repo, getRow, counts } = buildOcRepo(/* rejectCount */ 999);
    const bus = new PgSignalBus({ subscriptionRepo: repo });

    const matched = await bus.emit('go', { id: 'X' }, { n: 1 });
    // Not matched (queue gave up); payload not in row.
    assert.strictEqual(matched, 0);
    assert.deepStrictEqual(getRow().queuedPayloads, []);
    // Cap is 5 attempts.
    assert.strictEqual(counts().updateCalls, 5);
  });

  it('two concurrent emits both land via retry+ocr (no lost-update)', async () => {
    const { repo, getRow } = buildOcRepo(/* rejectCount */ 0);
    const bus = new PgSignalBus({ subscriptionRepo: repo });

    // Race the two emits. The first one to win the update bumps version;
    // the second sees its expectedVersion is now stale and retries.
    // Both payloads must end up in queuedPayloads.
    await Promise.all([
      bus.emit('go', { id: 'X' }, { n: 1 }),
      bus.emit('go', { id: 'X' }, { n: 2 }),
    ]);

    const final = getRow().queuedPayloads as Array<{ payload: { n: number } }>;
    assert.strictEqual(final.length, 2, `both payloads should be queued, got ${final.length}`);
    const ns = final.map((p) => p.payload.n).sort();
    assert.deepStrictEqual(ns, [1, 2], 'both payloads (n=1 and n=2) must be present, neither lost');
  });
});
