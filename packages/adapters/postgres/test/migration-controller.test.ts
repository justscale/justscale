/**
 * Migration Controller smoke test.
 *
 * The DI-native controller is exercised end-to-end by the CLI e2e tests
 * and the migration-runner.e2e.test.ts; this file just verifies the
 * exported constants exist and carry the expected shape after the
 * `createMigrationController` factory was retired.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  MigrationController,
  MigrationService,
} from '../src/migration/migration-controller.js';
import { PostgresMigrationFeature } from '../src/migration/migration-feature.js';
import { PostgresMigrationConfig } from '../src/config.js';

describe('Migration feature exports', () => {
  it('exports a controller def', () => {
    assert.ok(MigrationController, 'MigrationController should exist');
    assert.ok(typeof MigrationController === 'object', 'Controller is a ServiceDef-shaped object');
  });

  it('exports the migration service used by the controller', () => {
    assert.ok(MigrationService, 'MigrationService should exist');
    assert.ok('factory' in MigrationService, 'has DI factory');
  });

  it('exports the config partial with the expected name', () => {
    assert.strictEqual(PostgresMigrationConfig.name, 'postgres:migration');
  });

  it('exports the feature token', () => {
    assert.ok(PostgresMigrationFeature, 'Feature exists');
  });
});
