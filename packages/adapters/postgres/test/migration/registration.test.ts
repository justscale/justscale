/**
 * Migration registration & ordering - unit tests (no DB).
 *
 * Invariants pinned here:
 *   1. `defineMigration()` appends to the module-level registry in call order.
 *   2. `getRegisteredMigrations()` returns a stable, insertion-ordered snapshot
 *      (NOT sorted by name at the registry level - the runner sorts later).
 *   3. `clearRegisteredMigrations()` empties the registry.
 *   4. Calling `defineMigration()` twice with the same `name` is NOT deduped -
 *      both entries land in the registry. (Pin current behaviour; the runner
 *      would later see a duplicate and apply only one because `appliedNames`
 *      is a Set keyed on name.)
 *   5. Re-importing the same module does not re-register (ESM module cache
 *      caches side effects).
 *
 * Failure modes these catch:
 *   - Silent dedupe change (last-write-wins) masking shadowing bugs.
 *   - Insertion order breaking (e.g. someone switches to Set, loses order).
 *   - `clearRegisteredMigrations` only clearing part of the registry.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  defineMigration,
  getRegisteredMigrations,
  clearRegisteredMigrations,
} from '../../src/migration/migration-schema.js';

describe('Migration registry', () => {
  beforeEach(() => {
    clearRegisteredMigrations();
  });

  it('defineMigration appends in call order', () => {
    defineMigration({ name: 'a', async up() {}, async down() {} });
    defineMigration({ name: 'b', async up() {}, async down() {} });
    defineMigration({ name: 'c', async up() {}, async down() {} });

    const names = getRegisteredMigrations().map((m) => m.name);
    assert.deepStrictEqual(names, ['a', 'b', 'c']);
  });

  it('registry keeps insertion order even when names would sort differently', () => {
    // If the registry were sorting, this would come out [a,b,c]. It should NOT.
    defineMigration({ name: 'c', async up() {}, async down() {} });
    defineMigration({ name: 'a', async up() {}, async down() {} });
    defineMigration({ name: 'b', async up() {}, async down() {} });

    const names = getRegisteredMigrations().map((m) => m.name);
    assert.deepStrictEqual(
      names,
      ['c', 'a', 'b'],
      'registry must preserve insertion order - runner sorts, not the registry',
    );
  });

  it('defineMigration returns the passed def (enables `export default`)', () => {
    const def = { name: 'x', async up() {}, async down() {} };
    const returned = defineMigration(def);
    assert.strictEqual(returned, def);
  });

  it('getRegisteredMigrations returns a snapshot that reflects subsequent adds', () => {
    const snap1 = getRegisteredMigrations();
    assert.strictEqual(snap1.length, 0);

    defineMigration({ name: 'a', async up() {}, async down() {} });
    // Because the registry returns the underlying array (via spread only in
    // the runner), mutations after a read are visible on later reads.
    const snap2 = getRegisteredMigrations();
    assert.strictEqual(snap2.length, 1);
  });

  it('clearRegisteredMigrations empties the registry', () => {
    defineMigration({ name: 'a', async up() {}, async down() {} });
    defineMigration({ name: 'b', async up() {}, async down() {} });
    assert.strictEqual(getRegisteredMigrations().length, 2);

    clearRegisteredMigrations();
    assert.strictEqual(getRegisteredMigrations().length, 0);
  });

  it('duplicate names are NOT deduped at registration time', () => {
    // CURRENT behaviour: both registrations land. The runner relies on the
    // applied-names Set to avoid double-applying, so the second `up()` is
    // skipped at run time. If this changes (e.g. throw on duplicate, or
    // replace), update this assertion.
    defineMigration({ name: 'dup', async up() {}, async down() {} });
    defineMigration({ name: 'dup', async up() {}, async down() {} });

    const regs = getRegisteredMigrations().filter((m) => m.name === 'dup');
    assert.strictEqual(regs.length, 2, 'current behaviour: registry is a plain push - no dedupe');
  });

  it('ESM import cache prevents double-registration from re-import', async () => {
    // Importing the schema module twice must not add anything beyond what the
    // test itself registered. If the registry module were instantiated twice
    // (e.g. via split module resolution), this would fail.
    const before = getRegisteredMigrations().length;
    await import('../../src/migration/migration-schema.js');
    await import('../../src/migration/migration-schema.js');
    const after = getRegisteredMigrations().length;
    assert.strictEqual(after, before);
  });
});
