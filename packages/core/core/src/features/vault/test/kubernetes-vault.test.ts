import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JustScale from '../../../index.js';
import { KubernetesVault } from '../kubernetes-vault.js';
import { AbstractVaultClient, VAULT_KIND } from '../types.js';

describe('KubernetesVault', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jst-k8s-'));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {
      /* best-effort */
    }
  });

  async function make(opts: Parameters<typeof KubernetesVault>[0] = {}) {
    const app = JustScale().add(KubernetesVault({ mountPath: tmp, ...opts })).build();
    await app.compile().ready;
    return app.container.resolve(AbstractVaultClient);
  }

  it('reads a secret from a mounted file', async () => {
    mkdirSync(join(tmp, 'postgres'), { recursive: true });
    writeFileSync(join(tmp, 'postgres', 'url'), 'postgres://prod');
    const v = await make();
    assert.strictEqual(await v.read('postgres/url'), 'postgres://prod');
  });

  it('strips exactly one trailing newline', async () => {
    writeFileSync(join(tmp, 'tok'), 'abc\n');
    const v = await make();
    assert.strictEqual(await v.read('tok'), 'abc');
  });

  it('does not strip multiple trailing newlines', async () => {
    writeFileSync(join(tmp, 'multi'), 'abc\n\n');
    const v = await make();
    assert.strictEqual(await v.read('multi'), 'abc\n');
  });

  it('read() throws when secret is not mounted', async () => {
    const v = await make();
    await assert.rejects(
      () => v.read('not/there'),
      (err: Error) => /not mounted/.test(err.message),
    );
  });

  it('readOptional returns undefined on missing', async () => {
    const v = await make();
    assert.strictEqual(await v.readOptional('not/there'), undefined);
  });

  it('namespace prefix is applied', async () => {
    mkdirSync(join(tmp, 'ns1', 'a'), { recursive: true });
    writeFileSync(join(tmp, 'ns1', 'a', 'b'), 'scoped');
    const v = await make({ namespace: 'ns1' });
    assert.strictEqual(await v.read('a/b'), 'scoped');
  });

  it('different namespaces isolate paths', async () => {
    mkdirSync(join(tmp, 'ns1'), { recursive: true });
    mkdirSync(join(tmp, 'ns2'), { recursive: true });
    writeFileSync(join(tmp, 'ns1', 'tok'), 'A');
    writeFileSync(join(tmp, 'ns2', 'tok'), 'B');
    const v1 = await make({ namespace: 'ns1' });
    const v2 = await make({ namespace: 'ns2' });
    assert.strictEqual(await v1.read('tok'), 'A');
    assert.strictEqual(await v2.read('tok'), 'B');
  });

  it('VAULT_KIND brand is "kubernetes"', () => {
    const V = KubernetesVault();
    assert.strictEqual((V as unknown as Record<symbol, string>)[VAULT_KIND], 'kubernetes');
  });
});
