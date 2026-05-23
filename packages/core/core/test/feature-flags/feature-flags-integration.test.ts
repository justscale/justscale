import { describe, test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import JustScale, {
  defineService,
  defineFeatureFlagPartial,
  createFeatureFlagProvider,
  FeatureFlag,
  FeatureFlagServiceDef,
} from '../../src/index.js';

describe('feature-flags integration', () => {
  test('provider supplies initial values, service injects FeatureFlag.of()', async () => {
    const CheckoutFlags = defineFeatureFlagPartial('checkout.init', z.object({
      newPayment: z.boolean(),
      cohort: z.enum(['a', 'b']),
    }));

    const Provider = createFeatureFlagProvider({
      provides: [CheckoutFlags],
      factory: () => ({
        [CheckoutFlags.key]: { newPayment: true, cohort: 'a' as const },
      }),
    });

    class Checkout extends defineService({
      inject: { flags: FeatureFlag.of(CheckoutFlags) },
      factory: ({ flags }) => ({
        path: () => flags.newPayment ? 'new' : 'old',
        cohort: () => flags.cohort,
      }),
    }) {}

    const app = JustScale().add(Provider).add(Checkout).build();
    await app.compile().ready;

    const svc = await app.container.resolve(Checkout);
    assert.strictEqual(svc.path(), 'new');
    assert.strictEqual(svc.cohort(), 'a');
  });

  test('service.read() returns the current value', async () => {
    const P = defineFeatureFlagPartial('svc.read', z.object({ on: z.boolean() }));
    const Provider = createFeatureFlagProvider({
      provides: [P],
      factory: () => ({ [P.key]: { on: true } }),
    });

    const app = JustScale().add(FeatureFlagServiceDef).add(Provider).build();
    await app.compile().ready;

    const svc = await app.container.resolve(FeatureFlagServiceDef);
    const value = await svc.read(P);
    assert.strictEqual(value.on, true);
  });

  test('service.update() pushes new value, fires watchers', async () => {
    const P = defineFeatureFlagPartial('svc.update', z.object({ level: z.number() }));
    const Provider = createFeatureFlagProvider({
      provides: [P],
      factory: () => ({ [P.key]: { level: 1 } }),
    });

    const app = JustScale().add(FeatureFlagServiceDef).add(Provider).build();
    await app.compile().ready;

    const svc = await app.container.resolve(FeatureFlagServiceDef);

    // Collect updates via watch
    const updates: Array<[{ level: number }, { level: number }]> = [];
    const iter = svc.watch(P)[Symbol.asyncIterator]();
    const collect = (async () => {
      const result = await iter.next();
      if (!result.done) updates.push(result.value);
    })();

    // Small delay to ensure watcher is registered before update
    await new Promise((r) => setTimeout(r, 5));
    const notified = await svc.update(P, { level: 2 });
    await collect;

    assert.strictEqual(notified, 1);
    assert.deepStrictEqual(updates[0], [{ level: 1 }, { level: 2 }]);

    // Subsequent read returns updated value
    const current = await svc.read(P);
    assert.strictEqual(current.level, 2);

    // Clean up watcher
    await iter.return!();
  });

  test('update() validates against schema', async () => {
    const P = defineFeatureFlagPartial('svc.valid', z.object({ n: z.number().positive() }));
    const Provider = createFeatureFlagProvider({
      provides: [P],
      factory: () => ({ [P.key]: { n: 1 } }),
    });

    const app = JustScale().add(FeatureFlagServiceDef).add(Provider).build();
    await app.compile().ready;

    const svc = await app.container.resolve(FeatureFlagServiceDef);
    await assert.rejects(async () => svc.update(P, { n: -5 }));
  });

  test('update() skips notify when value is deep-equal to previous', async () => {
    const P = defineFeatureFlagPartial('svc.dedup', z.object({
      level: z.number(),
      nested: z.object({ x: z.number() }),
    }));
    const Provider = createFeatureFlagProvider({
      provides: [P],
      factory: () => ({ [P.key]: { level: 1, nested: { x: 1 } } }),
    });

    const app = JustScale().add(FeatureFlagServiceDef).add(Provider).build();
    await app.compile().ready;

    const svc = await app.container.resolve(FeatureFlagServiceDef);

    // Register a watcher so notify count is meaningful.
    const iter = svc.watch(P)[Symbol.asyncIterator]();

    try {
      // Same value — should NOT notify.
      assert.strictEqual(await svc.update(P, { level: 1, nested: { x: 1 } }), 0);

      // Different nested value — SHOULD notify (deep comparison).
      assert.strictEqual(await svc.update(P, { level: 1, nested: { x: 2 } }), 1);

      // Same top-level number, reference-different object — should NOT notify.
      assert.strictEqual(await svc.update(P, { level: 1, nested: { x: 2 } }), 0);
    } finally {
      await iter.return!();
    }
  });

  test('missing flag provider: validation fails at .build()', () => {
    const Missing = defineFeatureFlagPartial('missing.flag', z.object({ on: z.boolean() }));

    class Needs extends defineService({
      inject: { f: FeatureFlag.of(Missing) },
      factory: ({ f }) => ({ on: () => f.on }),
    }) {}

    // @ts-expect-error — intentionally missing dep to verify runtime error
    assert.throws(() => JustScale().add(Needs).build());
  });
});
