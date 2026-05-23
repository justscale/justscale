import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../../index.js';
import { EnvVarVault } from '../env-var-vault.js';
import { AbstractVaultClient, VAULT_KIND } from '../types.js';

describe('EnvVarVault', () => {
  const OWNED = new Set<string>();
  function setEnv(k: string, v: string | undefined): void {
    OWNED.add(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  beforeEach(() => {
    for (const k of OWNED) delete process.env[k];
    OWNED.clear();
  });
  afterEach(() => {
    for (const k of OWNED) delete process.env[k];
    OWNED.clear();
  });

  async function make() {
    const app = JustScale().add(EnvVarVault).build();
    await app.compile().ready;
    return app.container.resolve(AbstractVaultClient);
  }

  it('translates "postgres/url" → POSTGRES_URL', async () => {
    setEnv('POSTGRES_URL', 'the-url');
    const v = await make();
    assert.strictEqual(await v.read('postgres/url'), 'the-url');
  });

  it('translates dashes to underscores', async () => {
    setEnv('API_KEY_VALUE', 'k-value');
    const v = await make();
    assert.strictEqual(await v.read('api-key-value'), 'k-value');
  });

  it('upper-cases mixed case paths', async () => {
    setEnv('MIXEDCASE_PATH', 'y');
    const v = await make();
    assert.strictEqual(await v.read('MixedCase/path'), 'y');
  });

  it('read() throws with the translated env key in the message', async () => {
    const v = await make();
    await assert.rejects(
      () => v.read('missing/key'),
      (err: Error) => /MISSING_KEY.*is not set/.test(err.message),
    );
  });

  it('readOptional returns undefined on missing', async () => {
    const v = await make();
    assert.strictEqual(await v.readOptional('not/set'), undefined);
  });

  it('readOptional returns value on present', async () => {
    setEnv('PRESENT', 'yep');
    const v = await make();
    assert.strictEqual(await v.readOptional('present'), 'yep');
  });

  it('empty-string env var is treated as present (not missing)', async () => {
    setEnv('EMPTY_KEY', '');
    const v = await make();
    // process.env[key]='' is defined — `undefined` check misses it so read() returns ''.
    assert.strictEqual(await v.read('empty/key'), '');
    assert.strictEqual(await v.readOptional('empty/key'), '');
  });

  it('VAULT_KIND brand is "envvar"', () => {
    assert.strictEqual((EnvVarVault as unknown as Record<symbol, string>)[VAULT_KIND], 'envvar');
  });
});
