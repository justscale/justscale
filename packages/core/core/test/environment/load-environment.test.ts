import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEnvironment,
  loadEnvironment,
  detectEnvironmentName,
  isEnvironmentType,
  isEnvironment,
} from '../../src/index.js';

describe('loadEnvironment + detectEnvironmentName', () => {
  let tmpEnvDir: string;

  before(() => {
    tmpEnvDir = mkdtempSync(join(tmpdir(), 'justscale-env-test-'));

    // Write three env files
    writeFileSync(join(tmpEnvDir, 'production.js'), `
      import { createEnvironment } from '${import.meta.url.replace('/test/environment/load-environment.test.ts', '/src/index.ts')}';
      export default createEnvironment({
        name: 'production',
        type: 'production',
        public: { siteUrl: 'https://example.com' },
      });
    `);

    writeFileSync(join(tmpEnvDir, 'development.js'), `
      import { createEnvironment } from '${import.meta.url.replace('/test/environment/load-environment.test.ts', '/src/index.ts')}';
      export default createEnvironment({
        name: 'development',
        type: 'development',
        public: { siteUrl: 'http://localhost:3000' },
      });
    `);
  });

  after(() => {
    rmSync(tmpEnvDir, { recursive: true, force: true });
  });

  test('detectEnvironmentName defaults to development with no env vars', () => {
    const saved = { ...process.env };
    try {
      delete process.env.JUSTSCALE_ENV;
      delete process.env.NODE_ENV;
      assert.strictEqual(detectEnvironmentName(), 'development');
    } finally {
      Object.assign(process.env, saved);
    }
  });

  test('detectEnvironmentName respects JUSTSCALE_ENV', () => {
    const saved = process.env.JUSTSCALE_ENV;
    try {
      process.env.JUSTSCALE_ENV = 'acceptance';
      assert.strictEqual(detectEnvironmentName(), 'acceptance');
    } finally {
      if (saved === undefined) delete process.env.JUSTSCALE_ENV;
      else process.env.JUSTSCALE_ENV = saved;
    }
  });

  test('detectEnvironmentName returns "test" when NODE_ENV=test', () => {
    const savedJustscale = process.env.JUSTSCALE_ENV;
    const savedNode = process.env.NODE_ENV;
    try {
      delete process.env.JUSTSCALE_ENV;
      process.env.NODE_ENV = 'test';
      assert.strictEqual(detectEnvironmentName(), 'test');
    } finally {
      if (savedJustscale === undefined) delete process.env.JUSTSCALE_ENV;
      else process.env.JUSTSCALE_ENV = savedJustscale;
      if (savedNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNode;
    }
  });

  test('detectEnvironmentName returns "production" when NODE_ENV=production', () => {
    const savedJustscale = process.env.JUSTSCALE_ENV;
    const savedNode = process.env.NODE_ENV;
    try {
      delete process.env.JUSTSCALE_ENV;
      process.env.NODE_ENV = 'production';
      assert.strictEqual(detectEnvironmentName(), 'production');
    } finally {
      if (savedJustscale === undefined) delete process.env.JUSTSCALE_ENV;
      else process.env.JUSTSCALE_ENV = savedJustscale;
      if (savedNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNode;
    }
  });

  test('isEnvironmentType accepts valid names only', () => {
    assert.strictEqual(isEnvironmentType('production'), true);
    assert.strictEqual(isEnvironmentType('test'), true);
    assert.strictEqual(isEnvironmentType('development'), true);
    assert.strictEqual(isEnvironmentType('ci'), true);
    assert.strictEqual(isEnvironmentType('staging'), false);
    assert.strictEqual(isEnvironmentType(''), false);
  });

  test('loadEnvironment throws with actionable error when no file found', async () => {
    await assert.rejects(
      () => loadEnvironment({ envDir: tmpEnvDir, name: 'nonexistent' }),
      (err: Error) => {
        assert.match(err.message, /no env file found/);
        assert.match(err.message, /nonexistent/);
        return true;
      },
    );
  });

  test('loadEnvironment throws when file does not export an Environment', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'justscale-bad-env-'));
    try {
      writeFileSync(join(badDir, 'broken.js'), 'export default { notAnEnvironment: true };');
      await assert.rejects(
        () => loadEnvironment({ envDir: badDir, name: 'broken' }),
        (err: Error) => {
          assert.match(err.message, /must export default createEnvironment/);
          return true;
        },
      );
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  test('createEnvironment result satisfies isEnvironment guard', () => {
    const env = createEnvironment({
      name: 'test-env',
      type: 'development',
    });
    assert.ok(isEnvironment(env));
    assert.ok(!isEnvironment({ name: 'fake' }));
    assert.ok(!isEnvironment(null));
  });
});
