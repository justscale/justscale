import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../../index.js';
import { HashiCorpVault } from '../hashicorp-vault.js';
import { AbstractVaultClient, VAULT_KIND } from '../types.js';

// ---------------------------------------------------------------------------
// Fetch stub — swap the global while each test runs.
// ---------------------------------------------------------------------------
type FetchHandler = (url: string, init: RequestInit) => {
  status: number
  statusText?: string
  body: unknown
};

let origFetch: typeof fetch;
let handler: FetchHandler | null = null;

function stubFetch(fn: FetchHandler): void {
  handler = fn;
}

describe('HashiCorpVault', () => {
  beforeEach(() => {
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (!handler) throw new Error('no fetch handler set');
      const result = handler(String(url), init);
      return {
        status: result.status,
        statusText: result.statusText ?? '',
        ok: result.status >= 200 && result.status < 300,
        async json() { return result.body; },
      } as unknown as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    handler = null;
  });

  async function make(opts: Parameters<typeof HashiCorpVault>[0]) {
    const app = JustScale().add(HashiCorpVault(opts)).build();
    await app.compile().ready;
    return app.container.resolve(AbstractVaultClient);
  }

  it('v2 default: reads full object as JSON string', async () => {
    stubFetch((url, init) => {
      assert.strictEqual(url, 'https://v/v1/secret/data/postgres');
      assert.strictEqual((init.headers as Record<string, string>)['X-Vault-Token'], 't');
      return {
        status: 200,
        body: { data: { data: { url: 'postgres://a', user: 'b' } } },
      };
    });
    const v = await make({ url: 'https://v', token: 't' });
    const raw = await v.read('postgres');
    assert.deepStrictEqual(JSON.parse(raw), { url: 'postgres://a', user: 'b' });
  });

  it('v2 with #field selector returns just the field value', async () => {
    stubFetch(() => ({
      status: 200,
      body: { data: { data: { url: 'pg://x', secret: 's' } } },
    }));
    const v = await make({ url: 'https://v', token: 't' });
    assert.strictEqual(await v.read('postgres#url'), 'pg://x');
  });

  it('v1 reads from /<mount>/<path> (no /data segment)', async () => {
    stubFetch((url) => {
      assert.strictEqual(url, 'https://v/v1/secret/postgres');
      return { status: 200, body: { data: { url: 'pg://v1' } } };
    });
    const v = await make({ url: 'https://v', token: 't', kvVersion: 'v1' });
    assert.strictEqual(await v.read('postgres#url'), 'pg://v1');
  });

  it('custom mount is honoured', async () => {
    stubFetch((url) => {
      assert.ok(url.includes('/v1/kv2/data/pg'));
      return { status: 200, body: { data: { data: { k: 'v' } } } };
    });
    const v = await make({ url: 'https://v', token: 't', mount: 'kv2' });
    await v.read('pg#k');
  });

  it('404 → read throws', async () => {
    stubFetch(() => ({ status: 404, statusText: 'Not Found', body: {} }));
    const v = await make({ url: 'https://v', token: 't' });
    await assert.rejects(() => v.read('gone'), /no data at 'gone'/);
  });

  it('404 → readOptional returns undefined', async () => {
    stubFetch(() => ({ status: 404, statusText: 'Not Found', body: {} }));
    const v = await make({ url: 'https://v', token: 't' });
    assert.strictEqual(await v.readOptional('gone'), undefined);
  });

  it('non-404 error response throws with status', async () => {
    stubFetch(() => ({ status: 500, statusText: 'Internal', body: {} }));
    const v = await make({ url: 'https://v', token: 't' });
    await assert.rejects(
      () => v.read('x'),
      (err: Error) => /500 Internal/.test(err.message),
    );
  });

  it('missing #field throws when present', async () => {
    stubFetch(() => ({ status: 200, body: { data: { data: { other: 'yes' } } } }));
    const v = await make({ url: 'https://v', token: 't' });
    await assert.rejects(
      () => v.read('p#absent'),
      (err: Error) => /field 'absent' at 'p' is not set/.test(err.message),
    );
  });

  it('non-string field value is a type error', async () => {
    stubFetch(() => ({ status: 200, body: { data: { data: { n: 42 } } } }));
    const v = await make({ url: 'https://v', token: 't' });
    await assert.rejects(
      () => v.read('p#n'),
      (err: Error) => /not a string/.test(err.message),
    );
  });

  it('VAULT_KIND brand is "hashicorp"', () => {
    const V = HashiCorpVault({ url: '', token: '' });
    assert.strictEqual((V as unknown as Record<symbol, string>)[VAULT_KIND], 'hashicorp');
  });
});
