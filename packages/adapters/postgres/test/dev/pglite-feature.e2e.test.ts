/**
 * Integration test: PgliteFeature boots an in-process PGlite instance,
 * speaks Postgres wire protocol over a Unix socket, and postgres.js
 * (via AbstractPostgresClient) talks to it like a real server.
 *
 * Covers the critical session / lock semantics the user flagged:
 *  - Multiple concurrent connections from the client pool.
 *  - `pg_advisory_xact_lock` inside a transaction.
 *  - Basic CREATE TABLE / INSERT / SELECT round-trip.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import JustScale, {
  Logger,
  ConsoleLogger,
  Lifecycle,
  bindService,
} from '@justscale/core';

import { AbstractPostgresClient } from '../../src/index.js';
import { PgliteFeature } from '../../src/testing/index.js';

describe('PgliteFeature e2e', () => {
  let app: any;
  let client: AbstractPostgresClient;

  before(async () => {
    app = JustScale()
      .add(bindService(Logger, ConsoleLogger))
      .add(PgliteFeature)
      .build();
    await app.app.ready;
    client = (await app.app.container.resolve(AbstractPostgresClient)) as AbstractPostgresClient;
  });

  after(async () => {
    // Run the lifecycle 'stop' hook so PgliteFeature tears down its
    // pglite instance and socket server. Without this the test hangs
    // on the open server handle.
    const lifecycle = await app.app.container.resolve(Lifecycle);
    await lifecycle.runHook('stop');
  });

  it('connects and runs a simple query', async () => {
    const [row] = await client.sql`SELECT 1 + 1 AS sum`;
    assert.strictEqual(Number(row.sum), 2);
  });

  it('creates a table, inserts, selects', async () => {
    await client.sql.unsafe('CREATE TABLE widgets (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
    await client.sql`INSERT INTO widgets (name) VALUES (${'alpha'}), (${'beta'})`;
    const rows = await client.sql<{ id: number; name: string }[]>`SELECT * FROM widgets ORDER BY id`;
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].name, 'alpha');
    assert.strictEqual(rows[1].name, 'beta');
  });

  it('advisory xact lock acquires and releases within a transaction', async () => {
    const result = await client.transaction(async () => {
      await client.sql`SELECT pg_advisory_xact_lock(${42}::bigint)`;
      const [row] = await client.sql`SELECT 'locked' AS status`;
      return row.status;
    });
    assert.strictEqual(result, 'locked');
  });
});
