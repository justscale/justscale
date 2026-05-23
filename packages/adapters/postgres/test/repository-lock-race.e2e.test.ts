/**
 * Repository.lock() mutual-exclusion contract — REAL Postgres.
 *
 * The contract documented at `model.repository.ts:202-217` says:
 *   "Acquire an EXCLUSIVE LOCK on an entity ... the lock IS your
 *    concurrency control."
 *
 * As of when this file was written, the implementation does NOT honour
 * that contract — `Symbol.dispose` is a no-op and `SELECT FOR UPDATE`
 * runs in autocommit, so the row lock dies in one statement. Two
 * concurrent `lock()` calls on the same row both succeed.
 *
 * This file pins the DESIRED behaviour. Assertions that currently fail
 * are marked `it.todo` until Phases 2/3 of fix/lock-as-mutex land:
 *   Phase 2 — InMemoryRepository.lock() takes a real mutex via
 *             InMemoryLockProvider
 *   Phase 3 — PgRepository.lock() takes a real mutex via
 *             PostgresLockProvider (pg_advisory_lock)
 *
 * When those land, drop the `.todo` and the assertions should pass.
 * If they regress in the future, this test file is the canary.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

import { defineModel, field } from '@justscale/core/models';
import JustScale from '@justscale/core';
import { bindService, AbstractChannelBackend, MemoryChannelBackend } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import {
  createPostgresClient,
  createPgModel,
  createPgRepository,
  ModelChangeChannels,
  ModelRegistry,
} from '../src/index.js';
import { PgSchemaIntrospection } from '../src/migration/migration.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

const TEST_ID = 'lockrace';
const TABLE = `things_${TEST_ID}`;

class Thing extends defineModel({
  name: 'Thing_LockRace',
  fields: {
    label: field.string().max(255),
    counter: field.int().default(0),
  },
}) {}

describe('Repository.lock() mutex contract (real Postgres)', { timeout: 60000 }, async () => {
  if (!await requirePostgres()) return;

  ModelRegistry.clear();

  const sql = postgres(CONNECTION_STRING);
  const PgThing = createPgModel(Thing, { table: TABLE, storageMode: 'columnar' });
  const ThingRepository = createPgRepository(PgThing);
  const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });

  const app = JustScale()
    .add(InMemoryLockFeature)
    .add(InMemoryProcessFeature)
    .add(PostgresClient)
    .add(MemoryChannelBackend)
    .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
    .add(ModelChangeChannels)
    .add(ThingRepository)
    .build()
    .compile();
  await app.ready;

  const client = await app.container.resolve(PostgresClient);
  const repo = await app.container.resolve(ThingRepository);

  await new PgSchemaIntrospection(client).sync(PgThing);

  after(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await sql.end();
    await client.close();
  });

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM ${TABLE}`);
    client.clearIdentityMap();
  });

  // ─── Currently-passing properties ────────────────────────────────────────
  // These hold today and must keep holding after the fix.

  it('lock() returns null when the row was deleted before the call', async () => {
    const thing = await repo.insert({ label: 'gone', counter: 0 });
    {
      await using locked0 = await repo.lock(thing);
      assert.ok(locked0);
      await repo.delete(locked0);
    }

    await using locked1 = await repo.lock(thing);
    assert.equal(locked1, null, 'second lock sees the deletion and returns null');
  });

  it('lock() re-reads — sees fresh data after concurrent update', async () => {
    const thing = await repo.insert({ label: 'fresh', counter: 0 });
    {
      await using locked0 = await repo.lock(thing);
      assert.ok(locked0);
      await repo.update(locked0, { counter: 42 });
    }

    await using locked1 = await repo.lock(thing);
    assert.ok(locked1);
    assert.equal(
      locked1.counter,
      42,
      'lock re-fetches under the lock — sees the post-update value',
    );
  });

  // ─── Desired properties (currently failing — fix lands in Phase 3) ───────

  it('PROPERTY: two concurrent lock() calls on the same row serialize', async () => {
    // The whole point of a mutex.
    const thing = await repo.insert({ label: 'race', counter: 0 });

    const timeline: string[] = [];
    const start = Date.now();
    const stamp = (s: string) => timeline.push(`${Date.now() - start}ms ${s}`);

    const a = (async () => {
      stamp('A: lock-start');
      const lockedA = await repo.lock(thing);
      stamp('A: locked');
      // Hold the lock for 100ms so B's acquire MUST block.
      await new Promise((r) => setTimeout(r, 100));
      stamp('A: pre-release');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (lockedA as any)[Symbol.asyncDispose]();
      stamp('A: released');
    })();

    const b = (async () => {
      // Let A win the first acquire deterministically.
      await new Promise((r) => setTimeout(r, 10));
      stamp('B: lock-start');
      const lockedB = await repo.lock(thing);
      stamp('B: locked');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (lockedB as any)[Symbol.asyncDispose]();
    })();

    await Promise.all([a, b]);

    // The order MUST be: A locked → A released → B locked.
    // If B locks before A releases, the mutex is broken.
    const aLockedIdx = timeline.findIndex((s) => s.includes('A: locked'));
    const aReleasedIdx = timeline.findIndex((s) => s.includes('A: released'));
    const bLockedIdx = timeline.findIndex((s) => s.includes('B: locked'));

    assert.ok(aLockedIdx < aReleasedIdx, 'A locks before it releases');
    assert.ok(
      aReleasedIdx < bLockedIdx,
      `B must NOT lock until A releases. Timeline:\n${timeline.join('\n')}`,
    );
  });

  it('PROPERTY: re-entrant lock() in same async context throws DoubleLockError', async () => {
    const { runWithLockTracking } = await import('@justscale/core');
    const thing = await repo.insert({ label: 're-entrant', counter: 0 });
    await runWithLockTracking(async () => {
      await using locked = await repo.lock(thing);
      assert.ok(locked);
      await assert.rejects(
        () => repo.lock(thing),
        (err: Error) => err.name === 'DoubleLockError',
      );
    });
  });

  it('PROPERTY: using disposed Locked<T> in update() throws LockReleasedError', async () => {
    const thing = await repo.insert({ label: 'use-after-dispose', counter: 0 });
    let escaped: Awaited<ReturnType<typeof repo.lock>> = null;
    {
      const locked = await repo.lock(thing);
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

  it('PROPERTY: read from disposed Locked<T> still works (read-only degradation)', async () => {
    const thing = await repo.insert({ label: 'read-after-dispose', counter: 7 });
    let escaped: Awaited<ReturnType<typeof repo.lock>> = null;
    {
      const locked = await repo.lock(thing);
      escaped = locked;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (locked as any)[Symbol.asyncDispose]();
    }
    assert.ok(escaped);
    // Reading the snapshot is fine — Locked<T> degrades to read-only Persistent<T>.
    assert.equal(escaped!.counter, 7);
    assert.equal(escaped!.label, 'read-after-dispose');
  });
});
