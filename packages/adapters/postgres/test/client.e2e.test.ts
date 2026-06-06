/**
 * PostgreSQL Client E2E Tests
 *
 * Tests for connection management, transactions, and transaction hooks.
 */

import { describe, it, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRawPostgresClient, type AbstractPostgresClient } from '../src/client/client.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

describe('PostgreSQL Client E2E', async () => {
  if (!await requirePostgres()) return;

  let client: AbstractPostgresClient;
  let testTableName: string;

  before(async () => {
    client = createRawPostgresClient({ connectionString: CONNECTION_STRING });
  });

  after(async () => {
    await client.close();
  });

  beforeEach(async () => {
    testTableName = `test_client_${randomUUID().slice(0, 8).replace(/-/g, '_')}`;
    await client.sql.unsafe(`
      CREATE TABLE ${testTableName} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        value INTEGER DEFAULT 0
      )
    `);
  });

  afterEach(async () => {
    try {
      await client.sql.unsafe(`DROP TABLE IF EXISTS ${testTableName} CASCADE`);
    } catch {
      // Ignore cleanup errors
    }
  });

  // ============================================================================
  // Basic Connection
  // ============================================================================

  describe('Basic Connection', () => {
    it('should execute simple query', async () => {
      const result = await client.sql`SELECT 1 as value`;
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].value, 1);
    });

    it('should execute parameterized query', async () => {
      const name = 'test';
      const result = await client.sql`SELECT ${name} as name`;
      assert.strictEqual(result[0].name, 'test');
    });

    it('should insert and select data', async () => {
      await client.sql`INSERT INTO ${client.sql(testTableName)} (name, value) VALUES ('Alice', 100)`;

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)} WHERE name = 'Alice'`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].name, 'Alice');
      assert.strictEqual(rows[0].value, 100);
    });

    it('should not be in transaction by default', () => {
      assert.strictEqual(client.inTransaction, false);
      assert.strictEqual(client.transactionDepth, 0);
    });
  });

  // ============================================================================
  // Transactions
  // ============================================================================

  describe('Transactions', () => {
    it('should commit transaction on success', async () => {
      await client.transaction(async () => {
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Bob')`;
      });

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)} WHERE name = 'Bob'`;
      assert.strictEqual(rows.length, 1);
    });

    it('should rollback transaction on error', async () => {
      try {
        await client.transaction(async () => {
          await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Charlie')`;
          throw new Error('Intentional error');
        });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.strictEqual((err as Error).message, 'Intentional error');
      }

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)} WHERE name = 'Charlie'`;
      assert.strictEqual(rows.length, 0);
    });

    it('should be in transaction inside transaction block', async () => {
      let wasInTransaction = false;
      let depth = 0;

      await client.transaction(async () => {
        wasInTransaction = client.inTransaction;
        depth = client.transactionDepth;
      });

      assert.strictEqual(wasInTransaction, true);
      assert.strictEqual(depth, 0); // Root transaction has depth 0
    });

    it('should return value from transaction', async () => {
      const result = await client.transaction(async () => {
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name, value) VALUES ('Dave', 42) RETURNING id`;
        return { success: true, value: 42 };
      });

      assert.deepStrictEqual(result, { success: true, value: 42 });
    });
  });

  // ============================================================================
  // Nested Transactions (Savepoints)
  // ============================================================================

  describe('Nested Transactions (Savepoints)', () => {
    it('should support nested transactions', async () => {
      await client.transaction(async () => {
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Outer')`;

        await client.transaction(async () => {
          await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Inner')`;
        });
      });

      const rows = await client.sql`SELECT name FROM ${client.sql(testTableName)} ORDER BY name`;
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].name, 'Inner');
      assert.strictEqual(rows[1].name, 'Outer');
    });

    it('should increment depth for nested transactions', async () => {
      let outerDepth = -1;
      let innerDepth = -1;

      await client.transaction(async () => {
        outerDepth = client.transactionDepth;

        await client.transaction(async () => {
          innerDepth = client.transactionDepth;
        });
      });

      assert.strictEqual(outerDepth, 0);
      assert.strictEqual(innerDepth, 1);
    });

    it('should rollback only nested transaction on inner error', async () => {
      await client.transaction(async () => {
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Outer')`;

        try {
          await client.transaction(async () => {
            await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Inner')`;
            throw new Error('Inner error');
          });
        } catch {
          // Expected
        }

        // Outer transaction continues
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('After')`;
      });

      const rows = await client.sql`SELECT name FROM ${client.sql(testTableName)} ORDER BY name`;
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].name, 'After');
      assert.strictEqual(rows[1].name, 'Outer');
    });

    it('should rollback all on outer error after nested success', async () => {
      try {
        await client.transaction(async () => {
          await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Outer')`;

          await client.transaction(async () => {
            await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Inner')`;
          });

          throw new Error('Outer error after inner success');
        });
      } catch {
        // Expected
      }

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)}`;
      assert.strictEqual(rows.length, 0);
    });

    it('should support multiple levels of nesting', async () => {
      let maxDepth = 0;

      await client.transaction(async () => {
        maxDepth = Math.max(maxDepth, client.transactionDepth);

        await client.transaction(async () => {
          maxDepth = Math.max(maxDepth, client.transactionDepth);

          await client.transaction(async () => {
            maxDepth = Math.max(maxDepth, client.transactionDepth);
            await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Deep')`;
          });
        });
      });

      assert.strictEqual(maxDepth, 2);
      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)}`;
      assert.strictEqual(rows.length, 1);
    });
  });

  // ============================================================================
  // Transaction Hooks
  // ============================================================================

  describe('Transaction Hooks', () => {
    it('should call afterCommit hook on commit', async () => {
      let hookCalled = false;

      await client.transaction(async () => {
        client.afterCommit(() => {
          hookCalled = true;
        });
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Hook')`;
      });

      assert.strictEqual(hookCalled, true);
    });

    it('should not call afterCommit hook on rollback', async () => {
      let hookCalled = false;

      try {
        await client.transaction(async () => {
          client.afterCommit(() => {
            hookCalled = true;
          });
          throw new Error('Rollback');
        });
      } catch {
        // Expected
      }

      assert.strictEqual(hookCalled, false);
    });

    it('should call afterRollback hook on rollback', async () => {
      let hookCalled = false;

      try {
        await client.transaction(async () => {
          client.afterRollback(() => {
            hookCalled = true;
          });
          throw new Error('Rollback');
        });
      } catch {
        // Expected
      }

      assert.strictEqual(hookCalled, true);
    });

    it('should not call afterRollback hook on commit', async () => {
      let hookCalled = false;

      await client.transaction(async () => {
        client.afterRollback(() => {
          hookCalled = true;
        });
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Success')`;
      });

      assert.strictEqual(hookCalled, false);
    });

    it('should call afterCommit immediately when not in transaction', async () => {
      let hookCalled = false;

      client.afterCommit(() => {
        hookCalled = true;
      });

      // Wait a tick for async execution
      await new Promise(resolve => setTimeout(resolve, 10));

      assert.strictEqual(hookCalled, true);
    });

    // Regression coverage: a throwing afterRollback hook used to risk
    // suppressing the original tx error or skipping later hooks. Pin the
    // contract: original error always re-thrown, all hooks attempted,
    // throwing hooks logged but otherwise harmless.

    it('rethrows the original tx error EVEN when an afterRollback hook also throws', async () => {
      const origErr = console.error;
      console.error = () => {}; // swallow expected log output
      try {
        await assert.rejects(
          () =>
            client.transaction(async () => {
              client.afterRollback(() => {
                throw new Error('hook-error');
              });
              throw new Error('original-tx-error');
            }),
          // The original tx error must reach the caller, NOT the hook error.
          /original-tx-error/,
        );
      } finally {
        console.error = origErr;
      }
    });

    it('runs ALL afterRollback hooks even when an earlier one throws', async () => {
      const origErr = console.error;
      console.error = () => {};
      const ran: string[] = [];
      try {
        await assert.rejects(
          () =>
            client.transaction(async () => {
              client.afterRollback(() => { ran.push('first'); });
              client.afterRollback(() => {
                ran.push('second-throws');
                throw new Error('hook-2-failed');
              });
              client.afterRollback(() => { ran.push('third'); });
              throw new Error('rollback-trigger');
            }),
        );
      } finally {
        console.error = origErr;
      }
      // Hooks run in the order registered. All three must be attempted —
      // the throwing middle one must not block the third.
      assert.deepStrictEqual(ran, ['first', 'second-throws', 'third']);
    });

    it('purges identity map BEFORE running afterRollback hooks (cleanup not gated on hooks)', async () => {
      // Set up an entity in the identity map, simulate a rollback with a
      // throwing hook, and verify the identity map is cleared even though
      // the hook threw. If cleanup were AFTER hooks, a throwing hook would
      // leave ghost entities visible via getFromIdentityMap.
      const origErr = console.error;
      console.error = () => {};
      const sentinel = { sentinel: true };
      try {
        await assert.rejects(
          () =>
            client.transaction(async () => {
              client.storeInIdentityMap(testTableName, 'rollback-id', sentinel);
              client.afterRollback(() => {
                // Hook must NOT be the gate that clears the map.
                throw new Error('hook-fail');
              });
              throw new Error('force-rollback');
            }),
        );
      } finally {
        console.error = origErr;
      }
      // After the rollback, the identity map must be empty for that key
      // — even though the hook threw.
      assert.strictEqual(
        client.getFromIdentityMap(testTableName, 'rollback-id'),
        undefined,
        'identity map must be purged on rollback regardless of hook errors',
      );
    });

    it('should support async afterCommit hooks', async () => {
      let value = 0;

      await client.transaction(async () => {
        client.afterCommit(async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          value = 42;
        });
      });

      // Wait for async hook to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      assert.strictEqual(value, 42);
    });

    it('should call multiple hooks in order', async () => {
      const order: number[] = [];

      await client.transaction(async () => {
        client.afterCommit(() => {
          order.push(1);
        });
        client.afterCommit(() => {
          order.push(2);
        });
        client.afterCommit(() => {
          order.push(3);
        });
      });

      assert.deepStrictEqual(order, [1, 2, 3]);
    });

    it('should not run inner afterCommit hooks when a savepoint rolls back', async () => {
      let outerCommitted = false;
      let innerCommitted = false;

      await client.transaction(async () => {
        client.afterCommit(() => {
          outerCommitted = true;
        });

        try {
          await client.transaction(async () => {
            client.afterCommit(() => {
              innerCommitted = true;
            });

            throw new Error('Inner rollback');
          });
        } catch {
          // Expected
        }
      });

      assert.strictEqual(outerCommitted, true);
      assert.strictEqual(innerCommitted, false);
    });

    it('should run inner afterRollback hooks when a savepoint rolls back', async () => {
      let outerRolledBack = false;
      let innerRolledBack = false;

      await client.transaction(async () => {
        client.afterRollback(() => {
          outerRolledBack = true;
        });

        try {
          await client.transaction(async () => {
            client.afterRollback(() => {
              innerRolledBack = true;
            });

            throw new Error('Inner rollback');
          });
        } catch {
          // Expected
        }
      });

      assert.strictEqual(innerRolledBack, true);
      assert.strictEqual(outerRolledBack, false);
    });
  });

  // ============================================================================
  // Identity Map
  // ============================================================================

  describe('Identity Map', () => {
    beforeEach(() => {
      // Clear identity map between tests
      client.clearIdentityMap();
    });

    it('should return undefined when entity not stored', () => {
      const result = client.getFromIdentityMap('users', '123');
      assert.strictEqual(result, undefined);
    });

    it('should store and retrieve entity in transaction', async () => {
      const entity = { id: '123', name: 'Test' };

      await client.transaction(async () => {
        client.storeInIdentityMap('users', '123', entity);
        const retrieved = client.getFromIdentityMap<typeof entity>('users', '123');
        assert.strictEqual(retrieved, entity); // Same reference
      });
    });

    it('should persist identity map after transaction (global)', async () => {
      const entity = { id: '456', name: 'Test' };

      await client.transaction(async () => {
        client.storeInIdentityMap('users', '456', entity);
      });

      // Outside transaction - global identity map persists
      const result = client.getFromIdentityMap('users', '456');
      assert.strictEqual(result, entity);
    });

    it('should share identity map in nested transactions', async () => {
      const entity = { id: '789', name: 'Nested' };

      await client.transaction(async () => {
        client.storeInIdentityMap('users', '789', entity);

        await client.transaction(async () => {
          const retrieved = client.getFromIdentityMap<typeof entity>('users', '789');
          assert.strictEqual(retrieved, entity);
        });
      });
    });

    it('should clear identity map', async () => {
      const entity = { id: 'clear', name: 'Clear' };

      await client.transaction(async () => {
        client.storeInIdentityMap('users', 'clear', entity);
        assert.ok(client.getFromIdentityMap('users', 'clear'));

        client.clearIdentityMap();

        assert.strictEqual(client.getFromIdentityMap('users', 'clear'), undefined);
      });
    });
  });

  // ============================================================================
  // Isolation Levels
  // ============================================================================

  describe('Isolation Levels', () => {
    it('should support read committed isolation', async () => {
      await client.transaction(
        async () => {
          await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('ReadCommitted')`;
        },
        { isolationLevel: 'read committed' },
      );

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)}`;
      assert.strictEqual(rows.length, 1);
    });

    it('should support serializable isolation', async () => {
      await client.transaction(
        async () => {
          await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Serializable')`;
        },
        { isolationLevel: 'serializable' },
      );

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)}`;
      assert.strictEqual(rows.length, 1);
    });

    it('should support repeatable read isolation', async () => {
      await client.transaction(
        async () => {
          await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('RepeatableRead')`;
        },
        { isolationLevel: 'repeatable read' },
      );

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)}`;
      assert.strictEqual(rows.length, 1);
    });

    // The TS signature narrows isolationLevel to four string literals, but
    // a caller bypassing types via `as any` could otherwise route arbitrary
    // text into `SET TRANSACTION ISOLATION LEVEL <here>`. The allowlist
    // defends against that — these tests pin the rejection so a future
    // refactor can't quietly remove the guard.
    it('should reject SQL-injection-shaped isolationLevel via `as any`', async () => {
      await assert.rejects(
        () =>
          client.transaction(
            async () => { /* never runs */ },
            { isolationLevel: 'SERIALIZABLE; DROP TABLE users; --' as never },
          ),
        /Invalid isolation level/,
      );
    });

    it('should reject empty / whitespace-only isolationLevel via `as any`', async () => {
      await assert.rejects(
        () =>
          client.transaction(
            async () => { /* never runs */ },
            { isolationLevel: '' as never },
          ),
        /Invalid isolation level/,
      );
      await assert.rejects(
        () =>
          client.transaction(
            async () => { /* never runs */ },
            { isolationLevel: '   ' as never },
          ),
        /Invalid isolation level/,
      );
    });

    it('should reject case-mismatched isolationLevel via `as any`', async () => {
      // The allowlist keys are lowercase; uppercase / mixed-case bypasses
      // would have worked under the old `.toUpperCase()` interpolation.
      await assert.rejects(
        () =>
          client.transaction(
            async () => { /* never runs */ },
            { isolationLevel: 'SERIALIZABLE' as never },
          ),
        /Invalid isolation level/,
      );
    });
  });

  // ============================================================================
  // Pool Access
  // ============================================================================

  describe('Pool Access', () => {
    it('should provide pool access bypassing transaction', async () => {
      let usedPool = false;

      await client.transaction(async () => {
        // This uses the transaction
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('InTx')`;

        // This bypasses the transaction and goes directly to pool
        // Note: The insert won't be visible to the pool query since it's not committed
        usedPool = client.pool !== undefined;
      });

      assert.strictEqual(usedPool, true);
    });

    it('pool should be same as sql outside transaction', () => {
      // Outside transaction, sql and pool should be equivalent
      assert.ok(client.pool);
      assert.ok(client.sql);
    });
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe('Error Handling', () => {
    it('should handle SQL errors', async () => {
      try {
        await client.sql`SELECT * FROM nonexistent_table_${client.sql(randomUUID().slice(0, 8))}`;
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.ok((err as Error).message.includes('does not exist'));
      }
    });

    it('should rollback on SQL error in transaction', async () => {
      try {
        await client.transaction(async () => {
          await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Before Error')`;
          await client.sql`INSERT INTO nonexistent_table VALUES ('fail')`;
        });
        assert.fail('Should have thrown');
      } catch {
        // Expected
      }

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)}`;
      assert.strictEqual(rows.length, 0);
    });

    it('should handle constraint violations', async () => {
      // Add unique constraint
      await client.sql.unsafe(`ALTER TABLE ${testTableName} ADD CONSTRAINT uq_name UNIQUE (name)`);

      await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Unique')`;

      try {
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Unique')`;
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.ok((err as Error).message.includes('unique') || (err as Error).message.includes('duplicate'));
      }
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle empty result set', async () => {
      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)} WHERE 1=0`;
      assert.strictEqual(rows.length, 0);
      assert.ok(Array.isArray(rows));
    });

    it('should handle NULL values', async () => {
      // value column is nullable with DEFAULT 0, but we can explicitly set NULL
      await client.sql.unsafe(`INSERT INTO ${testTableName} (name, value) VALUES ('NullTest', NULL)`);

      const [row] = await client.sql`SELECT * FROM ${client.sql(testTableName)} WHERE name = 'NullTest'`;
      assert.strictEqual(row.value, null);
    });

    it('should handle very long strings', async () => {
      const longName = 'x'.repeat(100); // VARCHAR(100) limit
      await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES (${longName})`;

      const [row] = await client.sql`SELECT * FROM ${client.sql(testTableName)} WHERE name = ${longName}`;
      assert.strictEqual(row.name, longName);
    });

    it('should handle special characters in strings', async () => {
      const specialName = "O'Brien \"Test\" \\ Special";
      await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES (${specialName})`;

      const [row] = await client.sql`SELECT * FROM ${client.sql(testTableName)} WHERE name = ${specialName}`;
      assert.strictEqual(row.name, specialName);
    });

    it('should handle multiple concurrent transactions', async () => {
      // Start two transactions concurrently
      const results = await Promise.all([
        client.transaction(async () => {
          await client.sql`INSERT INTO ${client.sql(testTableName)} (name, value) VALUES ('Tx1', 1)`;
          return 'tx1';
        }),
        client.transaction(async () => {
          await client.sql`INSERT INTO ${client.sql(testTableName)} (name, value) VALUES ('Tx2', 2)`;
          return 'tx2';
        }),
      ]);

      assert.deepStrictEqual(results.sort(), ['tx1', 'tx2']);

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)} ORDER BY name`;
      assert.strictEqual(rows.length, 2);
    });

    it('should handle transaction that returns undefined', async () => {
      const result = await client.transaction(async () => {
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('NoReturn')`;
        // No explicit return
      });

      assert.strictEqual(result, undefined);
    });

    it('should handle deeply nested savepoints', async () => {
      const depths: number[] = [];

      await client.transaction(async () => {
        depths.push(client.transactionDepth);

        await client.transaction(async () => {
          depths.push(client.transactionDepth);

          await client.transaction(async () => {
            depths.push(client.transactionDepth);

            await client.transaction(async () => {
              depths.push(client.transactionDepth);
              await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Deep')`;
            });
          });
        });
      });

      assert.deepStrictEqual(depths, [0, 1, 2, 3]);

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)}`;
      assert.strictEqual(rows.length, 1);
    });

    it('should handle transaction hooks with async operations', async () => {
      const hookOrder: string[] = [];

      await client.transaction(async () => {
        client.afterCommit(async () => {
          await new Promise(resolve => setTimeout(resolve, 20));
          hookOrder.push('hook1');
        });
        client.afterCommit(async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          hookOrder.push('hook2');
        });
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Hooks')`;
      });

      // Wait for async hooks
      await new Promise(resolve => setTimeout(resolve, 100));

      // Hooks are called in order but may complete out of order due to async
      assert.strictEqual(hookOrder.length, 2);
    });

    it('should handle zero value in integer column', async () => {
      await client.sql`INSERT INTO ${client.sql(testTableName)} (name, value) VALUES ('Zero', 0)`;

      const [row] = await client.sql`SELECT * FROM ${client.sql(testTableName)} WHERE name = 'Zero'`;
      assert.strictEqual(row.value, 0);
    });

    it('should handle negative values', async () => {
      await client.sql`INSERT INTO ${client.sql(testTableName)} (name, value) VALUES ('Negative', -100)`;

      const [row] = await client.sql`SELECT * FROM ${client.sql(testTableName)} WHERE name = 'Negative'`;
      assert.strictEqual(row.value, -100);
    });

    it('should handle empty string values', async () => {
      await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('')`;

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)} WHERE name = ''`;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].name, '');
    });

    it('should handle many rows', async () => {
      // Insert 100 rows
      for (let i = 0; i < 100; i++) {
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name, value) VALUES (${`Row${i}`}, ${i})`;
      }

      const rows = await client.sql`SELECT * FROM ${client.sql(testTableName)}`;
      assert.strictEqual(rows.length, 100);
    });

    it('should handle rollback of partial nested transaction', async () => {
      await client.transaction(async () => {
        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Outer1')`;

        try {
          await client.transaction(async () => {
            await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Inner1')`;

            await client.transaction(async () => {
              await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('DeepInner')`;
              throw new Error('Deep error');
            });
          });
        } catch {
          // Inner nested transactions rolled back
        }

        await client.sql`INSERT INTO ${client.sql(testTableName)} (name) VALUES ('Outer2')`;
      });

      const rows = await client.sql`SELECT name FROM ${client.sql(testTableName)} ORDER BY name`;
      assert.strictEqual(rows.length, 2);
      assert.deepStrictEqual(rows.map(r => r.name), ['Outer1', 'Outer2']);
    });
  });
});

describe('PostgreSQL Client resilience options', async () => {
  if (!await requirePostgres()) return;

  test('statementTimeout aborts a runaway query server-side', async () => {
    const client = createRawPostgresClient({ connectionString: CONNECTION_STRING, statementTimeout: 400 });
    try {
      const t = Date.now();
      await assert.rejects(
        () => client.sql`SELECT pg_sleep(3)` as unknown as Promise<unknown>,
        (e: { code?: string }) => e.code === '57014', // canceling statement due to statement timeout
      );
      assert.ok(Date.now() - t < 2000, 'should abort well before the 3s sleep finishes');
    } finally {
      await client.close();
    }
  });

  test('no statementTimeout lets the same query run to completion', async () => {
    const client = createRawPostgresClient({ connectionString: CONNECTION_STRING });
    try {
      await client.sql`SELECT pg_sleep(1)`; // completes, no abort
    } finally {
      await client.close();
    }
  });

  test('keepAlive option is accepted and queries still work', async () => {
    // Lower keepAlive => faster detection of a silently-dead server (the
    // ~60s-freeze fix). Just assert it's a valid option and queries run.
    const client = createRawPostgresClient({ connectionString: CONNECTION_STRING, keepAlive: 5 });
    try {
      const rows = await client.sql`SELECT 1 AS ok` as unknown as Array<{ ok: number }>;
      assert.strictEqual(rows[0].ok, 1);
    } finally {
      await client.close();
    }
  });
});
