import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectEnvironmentName,
  isEnvironmentType,
  loadEnvironment,
  __registerStaticEnvironment,
  createEnvironment,
} from '../index.js';

describe('detectEnvironmentName', () => {
  let orig: { JUSTSCALE_ENV?: string; NODE_ENV?: string };
  beforeEach(() => {
    orig = { JUSTSCALE_ENV: process.env.JUSTSCALE_ENV, NODE_ENV: process.env.NODE_ENV };
    delete process.env.JUSTSCALE_ENV;
    delete process.env.NODE_ENV;
  });
  afterEach(() => {
    if (orig.JUSTSCALE_ENV !== undefined) process.env.JUSTSCALE_ENV = orig.JUSTSCALE_ENV;
    else delete process.env.JUSTSCALE_ENV;
    if (orig.NODE_ENV !== undefined) process.env.NODE_ENV = orig.NODE_ENV;
    else delete process.env.NODE_ENV;
  });

  it('$JUSTSCALE_ENV wins over everything', () => {
    process.env.JUSTSCALE_ENV = 'custom';
    process.env.NODE_ENV = 'production';
    assert.strictEqual(detectEnvironmentName(), 'custom');
  });

  it('NODE_ENV=test maps to "test"', () => {
    process.env.NODE_ENV = 'test';
    assert.strictEqual(detectEnvironmentName(), 'test');
  });

  it('NODE_ENV=production maps to "production"', () => {
    process.env.NODE_ENV = 'production';
    assert.strictEqual(detectEnvironmentName(), 'production');
  });

  it('fall-through default is "development"', () => {
    process.env.NODE_ENV = 'something-else';
    assert.strictEqual(detectEnvironmentName(), 'development');
  });
});

describe('isEnvironmentType', () => {
  it('accepts the canonical set', () => {
    assert.strictEqual(isEnvironmentType('production'), true);
    assert.strictEqual(isEnvironmentType('test'), true);
    assert.strictEqual(isEnvironmentType('development'), true);
    assert.strictEqual(isEnvironmentType('ci'), true);
  });

  it('rejects unknown types', () => {
    assert.strictEqual(isEnvironmentType('staging'), false);
    assert.strictEqual(isEnvironmentType(''), false);
    assert.strictEqual(isEnvironmentType('Production'), false); // case-sensitive
  });
});

describe('loadEnvironment', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jst-env-'));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {
      /* best-effort */
    }
  });

  // Env files generated on disk are plain ESM. They can't resolve the
  // workspace name `@justscale/core`, so inline an env object with the
  // ENVIRONMENT sentinel directly — this is exactly what isEnvironment
  // checks for.
  const envLiteral = (name: string, type: string) =>
    'const ENVIRONMENT = Symbol.for(\'justscale.environment\');\n' +
    `export default { [ENVIRONMENT]: true, name: ${JSON.stringify(name)}, type: ${JSON.stringify(type)}, public: {}, services: [], providers: [], vaultPolicy: {} };\n`;

  it('loads an env file from an explicit envDir', async () => {
    const envDir = join(tmp, 'env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'development.js'), envLiteral('loaded', 'development'));
    const env = await loadEnvironment({ envDir, name: 'development', extensions: ['.js'] });
    assert.strictEqual(env.name, 'loaded');
  });

  it('throws when file does not exist', async () => {
    await assert.rejects(
      () => loadEnvironment({ envDir: join(tmp, 'env'), name: 'missing', extensions: ['.js'] }),
      /no env file found for 'missing'/,
    );
  });

  it('throws when the file exists but does not export an Environment', async () => {
    const envDir = join(tmp, 'env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'bad.js'), 'export default { not: \'an env\' };\n');
    await assert.rejects(
      () => loadEnvironment({ envDir, name: 'bad', extensions: ['.js'] }),
      /must export default createEnvironment/,
    );
  });

  it('honours extension priority order', async () => {
    const envDir = join(tmp, 'env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'x.js'), 'export default { not: \'an env\' };\n');
    writeFileSync(join(envDir, 'x.mjs'), envLiteral('mjs', 'development'));
    // With .mjs first, it wins.
    const env = await loadEnvironment({ envDir, name: 'x', extensions: ['.mjs', '.js'] });
    assert.strictEqual(env.name, 'mjs');
  });

  it('__registerStaticEnvironment overrides FS lookup when envDir omitted', async () => {
    const staticEnv = createEnvironment({ name: 'static-reg', type: 'test' });
    __registerStaticEnvironment('static-reg', staticEnv);
    const loaded = await loadEnvironment({ name: 'static-reg' });
    assert.strictEqual(loaded, staticEnv);
  });

  it('__registerStaticEnvironment is bypassed when envDir is explicit', async () => {
    const fakeReg = createEnvironment({ name: 'fake', type: 'test' });
    __registerStaticEnvironment('real-fs', fakeReg);
    const envDir = join(tmp, 'env');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'real-fs.js'), envLiteral('real-fs-disk', 'test'));
    const loaded = await loadEnvironment({ envDir, name: 'real-fs', extensions: ['.js'] });
    assert.strictEqual(loaded.name, 'real-fs-disk');
  });
});
