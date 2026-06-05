/**
 * Repository rollback contract - transactional invariants.
 *
 * Claim: after `client.transaction(fn)` aborts, the repository must reflect
 * DB truth, never in-memory state left over from the aborted scope. This
 * catches the class of ORM bug where a rolled-back INSERT's entity is still
 * cached in an identity map and reads phantom-succeed.
 *
 * The framework doesn't lean on transactions as its primary consistency
 * primitive (that's `AbstractLockProvider`), but the migration system does -
 * and that's where the first rollback-ghost bug surfaced. This suite locks
 * in the contract for any future code that opts into `client.transaction()`.
 *
 * Scope: one adapter for now (pg). When a second transactional adapter
 * lands, lift this into `@justscale/testing/conformance/repository-rollback`.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import JustScale from '@justscale/core';
import { defineService, bindService, AbstractChannelBackend, MemoryChannelBackend } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import { defineModel, field } from '@justscale/core/models';
import {
  createPgModel,
  createPgRepository,
  ModelChangeChannels,
  AbstractPostgresClient,
  keyOf,
} from '../src/index.js';
import { createPostgresClient } from '../src/client/client.js';
import { ModelRegistry } from '../src/model/model-registry.js';
import { PgSchemaIntrospection } from '../src/migration/migration.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

const TABLE = 'users_rollback_contract';

class User extends defineModel({
  email: field.string().max(255),
  name: field.string(),
}) {}

const PgUser = createPgModel(User, { table: TABLE, storageMode: 'columnar' });
const UserRepository = createPgRepository(PgUser);
const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });
const UserService = defineService({ inject: { users: UserRepository }, factory: ({ users }) => users });

const built = JustScale()
  .add(InMemoryLockFeature)
  .add(InMemoryProcessFeature)
  .add(PostgresClient)
  .add(MemoryChannelBackend)
  .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
  .add(ModelChangeChannels)
  .add(UserRepository)
  .add(UserService)
  .build();

describe('Repository rollback contract (pg)', async () => {
  if (!(await requirePostgres())) return;

  let sql: postgres.Sql;
  let client: AbstractPostgresClient;
  let users: Awaited<ReturnType<typeof UserService.factory>>;

  before(async () => {
    ModelRegistry.clear();
    sql = postgres(CONNECTION_STRING);
    const app = built.compile();
    await app.ready;
    client = await app.container.resolve(AbstractPostgresClient);
    users = await app.container.resolve(UserService);
    await new PgSchemaIntrospection(client).sync(PgUser);
  });

  after(async () => {
    await sql`DROP TABLE IF EXISTS ${sql(TABLE)}`;
    await sql.end();
    await client.close();
  });

  beforeEach(async () => {
    await sql`TRUNCATE ${sql(TABLE)}`;
    client.clearIdentityMap();
  });

  // --------------------------------------------------------------------------
  // INSERT × rollback
  // --------------------------------------------------------------------------

  test('INSERT inside tx that throws -> get() returns undefined (DB truth, not ghost)', async () => {
    let id: string | undefined;
    await assert.rejects(
      client.transaction(async () => {
        const entity = await users.insert({ email: 'ghost@x.test', name: 'Ghost' });
        id = keyOf(entity);
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.ok(id);
    const resolved = await users.get(User.ref`${id!}`);
    assert.strictEqual(resolved, undefined, 'rolled-back insert must not resolve via identity map');

    const rows = await sql`SELECT 1 FROM ${sql(TABLE)} WHERE email = 'ghost@x.test'`;
    assert.strictEqual(rows.length, 0, 'DB row must not exist');
  });

  test('INSERT inside tx that commits -> get() returns the entity', async () => {
    const id = await client.transaction(async () => {
      const entity = await users.insert({ email: 'real@x.test', name: 'Real' });
      return keyOf(entity);
    });

    const resolved = await users.get(User.ref`${id}`);
    assert.ok(resolved, 'committed insert must resolve');
    assert.strictEqual(resolved!.email, 'real@x.test');
  });

  // --------------------------------------------------------------------------
  // UPDATE × rollback
  // --------------------------------------------------------------------------

  test('UPDATE inside tx that throws -> get() returns original, not mutated value', async () => {
    const seeded = await users.insert({ email: 'u@x.test', name: 'Original' });
    const id = keyOf(seeded);
    client.clearIdentityMap();

    await assert.rejects(
      client.transaction(async () => {
        await users.update(User.ref`${id}`, { name: 'Mutated' });
        throw new Error('abort');
      }),
      /abort/,
    );

    const resolved = await users.get(User.ref`${id}`);
    assert.ok(resolved);
    assert.strictEqual(resolved!.name, 'Original', 'rolled-back update must leave original intact');

    const [row] = await sql<{ name: string }[]>`SELECT name FROM ${sql(TABLE)} WHERE id = ${id}`;
    assert.strictEqual(row.name, 'Original');
  });

  // --------------------------------------------------------------------------
  // DELETE × rollback
  // --------------------------------------------------------------------------

  test('DELETE inside tx that throws -> get() still returns the row', async () => {
    const seeded = await users.insert({ email: 'd@x.test', name: 'Doomed' });
    const id = keyOf(seeded);
    client.clearIdentityMap();

    await assert.rejects(
      client.transaction(async () => {
        await users.delete(User.ref`${id}`);
        throw new Error('abort');
      }),
      /abort/,
    );

    const resolved = await users.get(User.ref`${id}`);
    assert.ok(resolved, 'rolled-back delete must leave the row readable');
    assert.strictEqual(resolved!.email, 'd@x.test');
  });

  // --------------------------------------------------------------------------
  // Nested (savepoint) rollback
  // --------------------------------------------------------------------------

  test('nested INSERT rolls back via savepoint; outer commit preserves only outer work', async () => {
    let innerId: string | undefined;
    let outerId: string | undefined;

    await client.transaction(async () => {
      const outer = await users.insert({ email: 'outer@x.test', name: 'Outer' });
      outerId = keyOf(outer);

      await assert.rejects(
        client.transaction(async () => {
          const inner = await users.insert({ email: 'inner@x.test', name: 'Inner' });
          innerId = keyOf(inner);
          throw new Error('savepoint-abort');
        }),
        /savepoint-abort/,
      );
    });

    assert.ok(outerId);
    assert.ok(innerId);

    const outerResolved = await users.get(User.ref`${outerId!}`);
    assert.ok(outerResolved, 'outer commit must persist');

    const innerResolved = await users.get(User.ref`${innerId!}`);
    assert.strictEqual(innerResolved, undefined, 'savepoint-rolled-back insert must not leak');
  });

  test('outer tx rollback invalidates BOTH outer and nested inserts', async () => {
    let outerId: string | undefined;
    let innerId: string | undefined;

    await assert.rejects(
      client.transaction(async () => {
        const outer = await users.insert({ email: 'o2@x.test', name: 'Outer2' });
        outerId = keyOf(outer);
        await client.transaction(async () => {
          const inner = await users.insert({ email: 'i2@x.test', name: 'Inner2' });
          innerId = keyOf(inner);
        });
        throw new Error('outer-abort');
      }),
      /outer-abort/,
    );

    assert.ok(outerId);
    assert.ok(innerId);
    assert.strictEqual(await users.get(User.ref`${outerId!}`), undefined, 'outer insert must be purged');
    assert.strictEqual(await users.get(User.ref`${innerId!}`), undefined, 'nested insert must be purged');
  });
});
