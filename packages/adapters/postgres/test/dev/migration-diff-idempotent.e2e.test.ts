/**
 * Reproduces the `just migrate make` double-generation bug.
 *
 * Scenario: run `migrate make` twice with `migrate run` between - the
 * second run should produce an empty diff (no schema changes), but does
 * not. If any of the `PgSchemaIntrospection.generate` passes after a
 * sync reports changes, the diff generator is fabricating work.
 *
 * The test synthesizes this against an in-process pglite DB so it
 * doesn't need a live Postgres.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import JustScale, {
  Logger,
  ConsoleLogger,
  Lifecycle,
  bindService,
} from '@justscale/core';
import { defineModel, field } from '@justscale/core/models';

import { AbstractPostgresClient, createPgModel, PgSchemaIntrospection } from '../../src/index.js';
import { PgliteFeature } from '../../src/testing/index.js';

describe('migrate make - idempotent diff', () => {
  let app: any;
  let client: AbstractPostgresClient;
  let schema: PgSchemaIntrospection;

  before(async () => {
    app = JustScale()
      .add(bindService(Logger, ConsoleLogger))
      .add(PgliteFeature)
      .build();
    await app.app.ready;
    client = (await app.app.container.resolve(AbstractPostgresClient)) as AbstractPostgresClient;
    schema = new PgSchemaIntrospection(client);
  });

  after(async () => {
    const lifecycle = await app.app.container.resolve(Lifecycle);
    await lifecycle.runHook('stop');
  });

  it('second pass reports no changes after sync', async () => {
    class User extends defineModel({
      email: field.string().max(255).unique(),
      displayName: field.string().max(100),
    }) {}
    const PgUser = createPgModel(User, { table: 'idem_users' });

    // First pass - models vs empty DB -> should create table.
    const first = await schema.sync(PgUser);
    assert.strictEqual(first.hasChanges, true, 'first pass must generate changes');

    // Second pass - models vs live DB that was just synced -> should be empty.
    const second = await schema.generate(PgUser);
    if (second.hasChanges) {
      const summary = second.changes.map((c) => `${c.type} ${c.table}${c.column ? '.' + c.column : ''}${c.index ? ' [' + c.index + ']' : ''}: ${c.sql}`).join('\n  ');
      assert.fail(`second pass reported spurious changes:\n  ${summary}`);
    }
  });

  it('second pass is empty when schema has a ref + index', async () => {
    class Author extends defineModel({
      name: field.string().max(100),
    }) {}
    class Post extends defineModel({
      title: field.string().max(255),
      author: field.ref(Author),
    }) {}

    const PgAuthor = createPgModel(Author, { table: 'idem_authors' });
    const PgPost = createPgModel(Post, {
      table: 'idem_posts',
      relations: { author: { onDelete: 'CASCADE' } },
    });

    const first = await schema.sync(PgAuthor, PgPost);
    assert.strictEqual(first.hasChanges, true);

    const second = await schema.generate(PgAuthor, PgPost);
    if (second.hasChanges) {
      const summary = second.changes.map((c) => `${c.type} ${c.table}${c.column ? '.' + c.column : ''}${c.index ? ' [' + c.index + ']' : ''}: ${c.sql}`).join('\n  ');
      assert.fail(`second pass reported spurious changes:\n  ${summary}`);
    }
  });

  it('second pass is empty when schema has an enum column', async () => {
    class Order extends defineModel({
      status: field.enum('idem_order_status', ['pending', 'paid', 'shipped'] as const),
    }) {}
    const PgOrder = createPgModel(Order, { table: 'idem_orders' });

    const first = await schema.sync(PgOrder);
    assert.strictEqual(first.hasChanges, true);

    const second = await schema.generate(PgOrder);
    if (second.hasChanges) {
      const summary = second.changes.map((c) => `${c.type} ${c.table}${c.column ? '.' + c.column : ''}${c.index ? ' [' + c.index + ']' : ''}: ${c.sql}`).join('\n  ');
      assert.fail(`second pass reported spurious changes:\n  ${summary}`);
    }
  });
});
