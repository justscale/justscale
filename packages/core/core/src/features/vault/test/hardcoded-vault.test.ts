import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../../index.js';
import { HardcodedVault } from '../hardcoded-vault.js';
import { AbstractVaultClient, VAULT_KIND } from '../types.js';

describe('HardcodedVault', () => {
  async function resolveClient(store: Record<string, string>) {
    const app = JustScale().add(HardcodedVault(store)).build();
    await app.compile().ready;
    return app.container.resolve(AbstractVaultClient);
  }

  it('read() returns the value when present', async () => {
    const v = await resolveClient({ 'k/a': 'one', 'k/b': 'two' });
    assert.strictEqual(await v.read('k/a'), 'one');
    assert.strictEqual(await v.read('k/b'), 'two');
  });

  it('read() throws with all known paths in the message when missing', async () => {
    const v = await resolveClient({ 'k/a': 'one', 'k/b': 'two' });
    await assert.rejects(
      () => v.read('k/missing'),
      (err: Error) => /no value at path 'k\/missing'.*k\/a, k\/b/.test(err.message),
    );
  });

  it('read() error lists "(none)" when store is empty', async () => {
    const v = await resolveClient({});
    await assert.rejects(
      () => v.read('lonely'),
      (err: Error) => /\(none\)/.test(err.message),
    );
  });

  it('readOptional() returns undefined when missing', async () => {
    const v = await resolveClient({ a: 'A' });
    assert.strictEqual(await v.readOptional('missing'), undefined);
  });

  it('readOptional() returns value when present', async () => {
    const v = await resolveClient({ a: 'A' });
    assert.strictEqual(await v.readOptional('a'), 'A');
  });

  it('VAULT_KIND brand is "hardcoded"', () => {
    const V = HardcodedVault({});
    assert.strictEqual((V as unknown as Record<symbol, string>)[VAULT_KIND], 'hardcoded');
  });

  it('each call produces a distinct service class (no shared-store aliasing)', async () => {
    const V1 = HardcodedVault({ k: 'one' });
    const V2 = HardcodedVault({ k: 'two' });
    assert.notStrictEqual(V1, V2);
    // wire V1 in one app, V2 in another — they don't share state.
    const a = JustScale().add(V1).build();
    const b = JustScale().add(V2).build();
    await a.compile().ready;
    await b.compile().ready;
    assert.strictEqual(await (await a.container.resolve(AbstractVaultClient)).read('k'), 'one');
    assert.strictEqual(await (await b.container.resolve(AbstractVaultClient)).read('k'), 'two');
  });
});
