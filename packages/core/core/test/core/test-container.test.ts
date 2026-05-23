/**
 * Tests for Container override / mock-style patterns using just the
 * core Container primitive (not TestContainer, which lives in a separate
 * package outside @justscale/core's dependency graph).
 *
 * Covers:
 *   - registerInstance overrides registerClass
 *   - registerInstance overrides a register'd ServiceDef
 *   - registerInstance for a token that's also a dep for another service
 *   - re-registering under the same token replaces the cache entry
 *   - registerFor then resolve via concrete token sees same instance
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Container, defineService } from '../../src/core/service.js';

describe('Container: registerInstance precedence', () => {
  it('registerInstance wins over registerClass', async () => {
    class Svc {
      value = 'class-default';
    }
    const c = new Container();
    c.registerClass(Svc);
    const override = new Svc();
    override.value = 'instance-override';
    c.registerInstance(Svc, override);
    const r = await c.resolve(Svc);
    assert.strictEqual(r.value, 'instance-override');
  });

  it('registerInstance wins over a register(ServiceDef)', async () => {
    const S = defineService({
      inject: {},
      factory: () => ({ tag: 'from-factory' }),
    });
    const c = new Container();
    c.register(S);
    c.registerInstance(S, { tag: 'from-override' } as any);
    const r = await c.resolve(S);
    assert.strictEqual(r.tag, 'from-override');
  });

  it('registerInstance of a dep flows into dependent services', async () => {
    class Dep {
      n = 0;
    }
    const Consumer = defineService({
      inject: { d: Dep },
      factory: ({ d }) => ({ read: () => d.n }),
    });
    const c = new Container();
    const customDep = new Dep();
    customDep.n = 99;
    c.registerInstance(Dep, customDep);
    c.register(Consumer);
    const consumer = await c.resolve(Consumer);
    assert.strictEqual(consumer.read(), 99);
  });

  it('re-registering under the same token replaces cache entry for the next resolve', async () => {
    class X {
      v = 'first';
    }
    const c = new Container();
    const first = new X();
    c.registerInstance(X, first);
    const a = await c.resolve(X);
    assert.strictEqual(a, first);

    const second = new X();
    second.v = 'second';
    c.registerInstance(X, second);
    const b = await c.resolve(X);
    assert.strictEqual(b, second);
    assert.strictEqual(b.v, 'second');
  });

  it('registerFor(Abstract, Impl) maps resolution via abstract to the implementation', async () => {
    abstract class Abs {
      abstract compute(): number;
    }
    const Impl = defineService({
      inject: {},
      factory: () => ({ compute: () => 42 }),
    });
    const c = new Container();
    c.register(Impl);
    c.registerFor(Abs as any, Impl);
    const viaAbs = (await c.resolve(Abs as any)) as any;
    const viaImpl = await c.resolve(Impl);
    assert.strictEqual(viaAbs, viaImpl);
    assert.strictEqual(viaAbs.compute(), 42);
  });
});

describe('Container: Logger factory override', () => {
  it('setLoggerFactory replaces the logger creator', async () => {
    const c = new Container();
    const tagged: string[] = [];
    c.setLoggerFactory({
      create: (ctx: string) => {
        tagged.push(ctx);
        return {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
          log: () => {},
          with: () => ({}) as any,
        } as any;
      },
    });
    const logger = c.createLogger('my-context');
    assert.ok(logger);
    assert.deepStrictEqual(tagged, ['my-context']);
  });
});
