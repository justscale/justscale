/**
 * InMemoryRepository.lock() mutex contract — unit-level canary.
 *
 * The contract documented at `model.repository.ts:202-217` says lock()
 * acquires "an exclusive lock" and "the lock IS your concurrency
 * control." As of when this file was written, InMemoryRepository's
 * `Symbol.dispose` is a no-op — lock() is just a fresh-read with type
 * branding, NOT a mutex.
 *
 * This file pins the DESIRED behaviour. Assertions that currently fail
 * are marked `it.todo` until Phase 2 of fix/lock-as-mutex lands:
 *   InMemoryRepository.lock() takes a real mutex via
 *   InMemoryLockProvider, blocks concurrent acquirers, releases on
 *   Symbol.asyncDispose.
 *
 * When that lands, drop the `.todo`. If it regresses, this file is the
 * canary.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defineModel, field, getModelFields } from '../../src/models/index.js';
import { InMemoryRepository } from '../../src/models/in-memory/in-memory-repository.js';
import { runWithLockTracking } from '../../src/features/lock/lock-service.js';

class Account extends defineModel({
  name: 'Account_LockRace',
  fields: {
    label: field.string().max(255),
    counter: field.int().default(0),
  },
}) {}

function makeRepo() {
  return new InMemoryRepository<Account>({ fieldDefs: getModelFields(Account) });
}

describe('InMemoryRepository.lock() mutex contract', () => {
  // ─── Currently-passing properties ────────────────────────────────────────

  it('lock() returns null when the row is gone', async () => {
    const repo = makeRepo();
    const acct = await repo.insert({ label: 'gone', counter: 0 });
    {
      await using locked = await repo.lock(acct);
      assert.ok(locked);
      await repo.delete(locked);
    }

    await using next = await repo.lock(acct);
    assert.equal(next, null);
  });

  it('lock() re-reads — sees fresh data after concurrent update', async () => {
    const repo = makeRepo();
    const acct = await repo.insert({ label: 'fresh', counter: 0 });
    {
      await using locked0 = await repo.lock(acct);
      assert.ok(locked0);
      await repo.update(locked0, { counter: 42 });
    }

    await using locked1 = await repo.lock(acct);
    assert.ok(locked1);
    assert.equal(locked1.counter, 42);
  });

  // ─── Desired properties (currently failing — fix lands in Phase 2) ───────

  it('PROPERTY: two concurrent lock() calls on the same row serialize', async () => {
    const repo = makeRepo();
    const acct = await repo.insert({ label: 'race', counter: 0 });

    const timeline: string[] = [];
    const start = Date.now();
    const stamp = (s: string) => timeline.push(`${Date.now() - start}ms ${s}`);

    const a = (async () => {
      stamp('A: lock-start');
      const lockedA = await repo.lock(acct);
      stamp('A: locked');
      await new Promise((r) => setTimeout(r, 50));
      stamp('A: pre-release');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (lockedA as any)[Symbol.asyncDispose]();
      stamp('A: released');
    })();

    const b = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      stamp('B: lock-start');
      const lockedB = await repo.lock(acct);
      stamp('B: locked');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (lockedB as any)[Symbol.asyncDispose]();
    })();

    await Promise.all([a, b]);

    const aReleasedIdx = timeline.findIndex((s) => s.includes('A: released'));
    const bLockedIdx = timeline.findIndex((s) => s.includes('B: locked'));
    assert.ok(
      aReleasedIdx < bLockedIdx,
      `B must NOT lock until A releases. Timeline:\n${timeline.join('\n')}`,
    );
  });

  it('PROPERTY: re-entrant lock() in same async context throws DoubleLockError', async () => {
    // Re-entry detection requires runWithLockTracking — without it, a
    // second lock() on the same row from the same code would block
    // (deadlock). The tracking context is the opt-in for the throw.
    const repo = makeRepo();
    const acct = await repo.insert({ label: 're-entrant', counter: 0 });
    await runWithLockTracking(async () => {
      await using locked = await repo.lock(acct);
      assert.ok(locked);
      await assert.rejects(
        () => repo.lock(acct),
        (err: Error) => err.name === 'DoubleLockError',
      );
    });
  });

  it('PROPERTY: using disposed Locked<T> in update() throws LockReleasedError', async () => {
    const repo = makeRepo();
    const acct = await repo.insert({ label: 'use-after-dispose', counter: 0 });
    let escaped: Awaited<ReturnType<typeof repo.lock>> = null;
    {
      const locked = await repo.lock(acct);
      escaped = locked;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (locked as any)[Symbol.asyncDispose]();
    }
    assert.ok(escaped);
    await assert.rejects(
      () => repo.update(escaped!, { counter: 99 }),
      (err: Error) => err.name === 'LockReleasedError',
    );
  });

  it('PROPERTY: using disposed Locked<T> in delete() throws LockReleasedError', async () => {
    const repo = makeRepo();
    const acct = await repo.insert({ label: 'use-after-dispose-del', counter: 0 });
    let escaped: Awaited<ReturnType<typeof repo.lock>> = null;
    {
      const locked = await repo.lock(acct);
      escaped = locked;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (locked as any)[Symbol.asyncDispose]();
    }
    assert.ok(escaped);
    await assert.rejects(
      () => repo.delete(escaped!),
      (err: Error) => err.name === 'LockReleasedError',
    );
  });

  it('PROPERTY: read from disposed Locked<T> still works (read-only degradation)', async () => {
    const repo = makeRepo();
    const acct = await repo.insert({ label: 'read-after-dispose', counter: 7 });
    let escaped: Awaited<ReturnType<typeof repo.lock>> = null;
    {
      const locked = await repo.lock(acct);
      escaped = locked;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (locked as any)[Symbol.asyncDispose]();
    }
    assert.ok(escaped);
    assert.equal(escaped!.counter, 7);
    assert.equal(escaped!.label, 'read-after-dispose');
  });
});
