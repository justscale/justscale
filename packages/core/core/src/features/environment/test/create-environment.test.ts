import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createEnvironment,
  isEnvironment,
  ENVIRONMENT,
  DEFAULT_VAULT_POLICY,
} from '../index.js';

describe('createEnvironment', () => {
  it('brands the result so isEnvironment narrows', () => {
    const env = createEnvironment({ name: 'test-env', type: 'test' });
    assert.strictEqual(isEnvironment(env), true);
    assert.strictEqual((env as unknown as Record<symbol, unknown>)[ENVIRONMENT], true);
  });

  it('populates defaults when optional fields are omitted', () => {
    const env = createEnvironment({ name: 'dev', type: 'development' });
    assert.deepStrictEqual(env.public, {});
    assert.deepStrictEqual(env.services, []);
    assert.deepStrictEqual(env.providers, []);
  });

  it('preserves provided public values', () => {
    const env = createEnvironment({
      name: 'p',
      type: 'production',
      public: { siteUrl: 'https://x.y' },
    });
    assert.deepStrictEqual(env.public, { siteUrl: 'https://x.y' });
  });

  it('uses the default vault policy for the env type', () => {
    const prod = createEnvironment({ name: 'p', type: 'production' });
    assert.deepStrictEqual(
      prod.vaultPolicy.disallow,
      DEFAULT_VAULT_POLICY.production.disallow,
    );
  });

  it('extends the default vault policy with user-provided rules', () => {
    const env = createEnvironment({
      name: 'p',
      type: 'production',
      vaultPolicy: { extend: { warn: ['custom' as const] } },
    });
    // disallow from default preserved
    assert.ok(env.vaultPolicy.disallow?.includes('hardcoded'));
    // warn added from extend
    assert.ok(env.vaultPolicy.warn?.includes('custom' as never));
  });

  it('test type has empty default vault policy (permissive)', () => {
    const env = createEnvironment({ name: 't', type: 'test' });
    assert.deepStrictEqual(env.vaultPolicy.disallow ?? [], []);
    assert.deepStrictEqual(env.vaultPolicy.warn ?? [], []);
  });

  it('dev and test tolerate HardcodedVault (no disallow)', () => {
    const dev = createEnvironment({ name: 'd', type: 'development' });
    assert.ok(!(dev.vaultPolicy.disallow ?? []).includes('hardcoded'));
  });

  it('production and ci disallow hardcoded vaults', () => {
    assert.ok(DEFAULT_VAULT_POLICY.production.disallow!.includes('hardcoded'));
    assert.ok(DEFAULT_VAULT_POLICY.ci.disallow!.includes('hardcoded'));
  });

  it('isEnvironment narrows negatively on non-environment values', () => {
    assert.strictEqual(isEnvironment(null), false);
    assert.strictEqual(isEnvironment(undefined), false);
    assert.strictEqual(isEnvironment({}), false);
    assert.strictEqual(isEnvironment({ name: 'x', type: 'test' }), false);
  });
});
