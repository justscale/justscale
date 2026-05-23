import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import JustScale, { defineService } from '../../../index.js';
import {
  defineSecretPartial,
  createSecretProvider,
  SecretServiceDef,
  Secret,
} from '../index.js';

describe('SecretService', () => {
  it('.read returns the provided value', async () => {
    const P = defineSecretPartial('svc.read', z.object({ token: z.string() }));
    const Prov = createSecretProvider({
      provides: [P],
      factory: () => ({ [P.key]: { token: 'abc' } }),
    });
    class Svc extends defineService({
      inject: { secrets: SecretServiceDef },
      factory: ({ secrets }) => ({
        go: async () => (await secrets.read(P)).token,
      }),
    }) {}
    const app = JustScale().add(Prov).add(SecretServiceDef).add(Svc).build();
    await app.compile().ready;
    assert.strictEqual(await (await app.container.resolve(Svc)).go(), 'abc');
  });

  it('.read throws a friendly error when no provider registered the partial', async () => {
    // SecretService.read routes through Secret.of(partial) so the container
    // returns undefined on miss; SecretService surfaces the documented
    // message instead of the cryptic "'deps' in Symbol" TypeError that
    // used to bubble out of resolveInternal.
    const P = defineSecretPartial('svc.noprov', z.object({ x: z.string() }));
    const app = JustScale().add(SecretServiceDef).build();
    await app.compile().ready;
    const svc = await app.container.resolve(SecretServiceDef);
    await assert.rejects(
      () => svc.read(P),
      (err: Error) =>
        /no provider registered a value for secret partial 'svc.noprov'/.test(err.message),
    );
  });

  it('zod validation on secret shape rejects at boot', async () => {
    const P = defineSecretPartial('svc.strict', z.object({ token: z.string().min(10) }));
    const Prov = createSecretProvider({
      provides: [P],
      factory: () => ({ [P.key]: { token: 'short' } }),
    });
    await assert.rejects(async () => {
      const app = JustScale().add(Prov).build();
      await app.compile().ready;
    });
  });

  it('missing secret from DI graph fails validation at .build()', () => {
    const Missing = defineSecretPartial('svc.missing', z.object({ v: z.string() }));
    class NeedsIt extends defineService({
      inject: { s: Secret.of(Missing) },
      factory: ({ s }) => ({ v: () => s.v }),
    }) {}
    assert.throws(
      // @ts-expect-error — missing secret dep
      () => JustScale().add(NeedsIt).build(),
    );
  });

  it('async provider with injected vault returns resolved value', async () => {
    class FakeVault extends defineService({
      inject: {},
      factory: () => ({
        async read(path: string) {
          return `v-${path}`;
        },
      }),
    }) {}

    const P = defineSecretPartial('svc.async', z.object({ url: z.string() }));
    const Prov = createSecretProvider({
      provides: [P],
      inject: { v: FakeVault },
      factory: async ({ v }) => ({
        [P.key]: { url: await v.read('pg/url') },
      }),
    });

    class Svc extends defineService({
      inject: { s: Secret.of(P) },
      factory: ({ s }) => ({ get: () => s.url }),
    }) {}

    const app = JustScale().add(FakeVault).add(Prov).add(Svc).build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(Svc)).get(), 'v-pg/url');
  });

  it('one provider supplying two partials registers both', async () => {
    const A = defineSecretPartial('svc.multi.a', z.object({ a: z.string() }));
    const B = defineSecretPartial('svc.multi.b', z.object({ b: z.string() }));
    const Prov = createSecretProvider({
      provides: [A, B],
      factory: () => ({ [A.key]: { a: 'Aval' }, [B.key]: { b: 'Bval' } }),
    });
    class R extends defineService({
      inject: { a: Secret.of(A), b: Secret.of(B) },
      factory: ({ a, b }) => ({ join: () => `${a.a}/${b.b}` }),
    }) {}
    const app = JustScale().add(Prov).add(R).build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).join(), 'Aval/Bval');
  });

  it('secret values are read-only in practice — no .set exists on the service', async () => {
    const app = JustScale().add(SecretServiceDef).build();
    await app.compile().ready;
    const svc = await app.container.resolve(SecretServiceDef);
    // Intentional structural assertion — contractually SecretService has no
    // mutation API. Verify by runtime shape.
    assert.strictEqual((svc as unknown as Record<string, unknown>).set, undefined);
    assert.strictEqual((svc as unknown as Record<string, unknown>).watch, undefined);
    assert.strictEqual(typeof svc.read, 'function');
  });
});
