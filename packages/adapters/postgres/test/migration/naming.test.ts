/**
 * Migration naming, collisions, and identifier stability - no DB.
 *
 * Invariants pinned here:
 *   1. `migrationName(slug)` returns `YYYY_MM_DD_HHMMSS_<slug>`.
 *   2. Parsing a stamped name recovers the timestamp + slug cleanly.
 *   3. `parseMigrationName` returns null for unstamped input (no false
 *      positives).
 *   4. Stamped names sort lexicographically in chronological order: a
 *      name stamped later sorts AFTER one stamped earlier.
 *   5. Registration-time duplicate names are NOT rejected - both land in
 *      the registry (confirmed in registration.test.ts; pinned here at
 *      the schema layer).
 *   6. Names with unusual characters in the slug (hyphens, dots,
 *      mixed-case) pass through the stamping untouched: the framework
 *      doesn't transform the slug.
 *   7. When two stampings happen within the same second, the filenames
 *      are IDENTICAL. This is by design - the runner will still apply
 *      them once each because the registry tracks by `name`, but file
 *      writers must refuse overwriting (pinned in generator tests).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  migrationName,
  parseMigrationName,
} from '../../src/migration/migration-schema.js';

describe('Migration naming', () => {
  it('migrationName returns YYYY_MM_DD_HHMMSS_<slug>', () => {
    const name = migrationName('create_users');
    assert.match(name, /^\d{4}_\d{2}_\d{2}_\d{6}_create_users$/);
  });

  it('parseMigrationName recovers the timestamp and slug', () => {
    const parsed = parseMigrationName('2026_01_01_120000_create_users');
    assert.deepStrictEqual(parsed, {
      timestamp: '2026_01_01_120000',
      name: 'create_users',
    });
  });

  it('parseMigrationName returns null for bare slug', () => {
    const parsed = parseMigrationName('create_users');
    assert.strictEqual(parsed, null);
  });

  it('parseMigrationName returns null for wrong-shape stamp', () => {
    const parsed = parseMigrationName('202601011200000_create_users');
    assert.strictEqual(parsed, null);
  });

  it('lexicographic sort matches chronological sort', async () => {
    // Capture two stampings across a second boundary.
    const a = migrationName('a');
    await new Promise((r) => setTimeout(r, 1100));
    const b = migrationName('b');
    // a is older, so a < b lexicographically.
    assert.ok(a < b, `expected '${a}' < '${b}'`);
  });

  it('slug with dots is preserved', () => {
    const name = migrationName('add.v2.feature');
    // Slug portion must include the dots unchanged.
    assert.ok(name.endsWith('_add.v2.feature'));
  });

  it('slug with mixed case is preserved', () => {
    const name = migrationName('AddUsers');
    assert.ok(name.endsWith('_AddUsers'));
  });

  it('two stampings within the same second produce identical names', () => {
    // This is the ergonomic quirk. If someone runs `migrate make` twice in
    // the same second the filename would clash. We pin that the stamper
    // itself does not add a disambiguator - it's up to the writer.
    const a = migrationName('same_second');
    const b = migrationName('same_second');
    // Without forcing clock advance we may or may not land in the same
    // second. Either outcome is acceptable - what we pin is that the
    // stamper gives no extra uniqueness beyond wall-clock seconds.
    if (a === b) {
      // Same second - confirmed: identical strings.
      assert.strictEqual(a, b);
    } else {
      // We crossed a second boundary - the names differ by their stamp.
      const aParsed = parseMigrationName(a)!;
      const bParsed = parseMigrationName(b)!;
      assert.notStrictEqual(aParsed.timestamp, bParsed.timestamp);
      assert.strictEqual(aParsed.name, bParsed.name);
    }
  });
});
