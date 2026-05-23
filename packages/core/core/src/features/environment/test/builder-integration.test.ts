import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../../index.js';
import { createEnvironment } from '../index.js';
import { HardcodedVault } from '../../vault/hardcoded-vault.js';
import { EnvVarVault } from '../../vault/env-var-vault.js';

describe('Environment + builder integration', () => {
  it('test-type environment accepts HardcodedVault', async () => {
    const env = createEnvironment({
      name: 't',
      type: 'test',
      services: [HardcodedVault({ foo: 'bar' })],
    });
    // Build succeeds
    const app = JustScale().add(env).build();
    await app.compile().ready;
  });

  it('development-type environment accepts HardcodedVault', async () => {
    const env = createEnvironment({
      name: 'd',
      type: 'development',
      services: [HardcodedVault({ a: 'b' })],
    });
    const app = JustScale().add(env).build();
    await app.compile().ready;
  });

  it('production-type environment rejects HardcodedVault at build', () => {
    const env = createEnvironment({
      name: 'p',
      // `type: 'production'` forbids hardcoded vault — HardcodedVault brand
      // is runtime-checked by applyEnvironment. The TS-level error is
      // intentionally suppressed to test the runtime guard.
      type: 'production',
      // @ts-expect-error — VaultAllowedIn<'development'|'test'> conflicts with 'production'
      services: [HardcodedVault({ a: 'b' })],
    });
    assert.throws(
      () => JustScale().add(env).build(),
      /disallows vault kind 'hardcoded'/,
    );
  });

  it('ci-type environment rejects HardcodedVault at build', () => {
    const env = createEnvironment({
      name: 'c',
      type: 'ci',
      // @ts-expect-error — see above
      services: [HardcodedVault({ a: 'b' })],
    });
    assert.throws(
      () => JustScale().add(env).build(),
      /disallows vault kind 'hardcoded'/,
    );
  });

  it('production-type environment accepts EnvVarVault', async () => {
    const env = createEnvironment({
      name: 'p',
      type: 'production',
      services: [EnvVarVault],
    });
    const app = JustScale().add(env).build();
    await app.compile().ready;
  });

  it('only one environment may be registered per app', () => {
    const a = createEnvironment({ name: 'a', type: 'test' });
    const b = createEnvironment({ name: 'b', type: 'test' });
    assert.throws(
      () => JustScale().add(a).add(b).build(),
      /Only one environment may be registered/,
    );
  });

  it('same-name environment added twice is idempotent', async () => {
    const env = createEnvironment({ name: 'same', type: 'test' });
    // Same identity — the guard compares by `name`, so re-adding should work.
    const app = JustScale().add(env).add(env).build();
    await app.compile().ready;
  });

  it('vault-policy warn triggers console.warn instead of throwing', async () => {
    const warnSpy: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnSpy.push(args);
    try {
      const env = createEnvironment({
        name: 'w',
        type: 'test',
        services: [HardcodedVault({})],
        vaultPolicy: { extend: { warn: ['hardcoded'] } },
      });
      const app = JustScale().add(env).build();
      await app.compile().ready;
      assert.ok(
        warnSpy.some((args) =>
          typeof args[0] === 'string' && args[0].includes("vault kind 'hardcoded'"),
        ),
      );
    } finally {
      console.warn = orig;
    }
  });
});
