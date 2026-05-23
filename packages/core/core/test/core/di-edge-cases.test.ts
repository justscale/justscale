/**
 * Edge-case tests for defineService / Container / DI resolution.
 *
 * Covers:
 *   - zero / single / N dep resolution ordering
 *   - lazy resolution
 *   - idempotency
 *   - circular dep detection (or not!)
 *   - various token kinds (class, abstract, ServiceDef, symbol-ish)
 *   - cross-container isolation
 *   - error shapes
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  Container,
  CircularDependencyError,
  defineService,
  defineAbstract,
  SERVICE_ID,
  SERVICE_PROVIDES,
  getServiceId,
  getServiceIdValue,
  getServiceProvides,
} from '../../src/core/service.js';

describe('DI: zero-dep services', () => {
  it('resolves a defineService with empty inject', async () => {
    const S = defineService({ inject: {}, factory: () => ({ v: 1 }) });
    const c = new Container();
    c.register(S);
    const r = await c.resolve(S);
    assert.strictEqual(r.v, 1);
  });

  it('factory is never called before resolve', async () => {
    let called = 0;
    const S = defineService({
      inject: {},
      factory: () => {
        called++;
        return { ok: true };
      },
    });
    const c = new Container();
    c.register(S);
    assert.strictEqual(called, 0);
    await c.resolve(S);
    assert.strictEqual(called, 1);
  });
});

describe('DI: single dep happy path', () => {
  it('resolves a service with one class dep', async () => {
    class Dep {
      value = 'dep-val';
    }
    const S = defineService({
      inject: { dep: Dep },
      factory: ({ dep }) => ({ read: () => dep.value }),
    });
    const c = new Container();
    c.registerClass(Dep);
    c.register(S);
    const s = await c.resolve(S);
    assert.strictEqual(s.read(), 'dep-val');
  });
});

describe('DI: N dependency resolution ordering', () => {
  it('resolves deps before the consumer, and all share singletons', async () => {
    const order: string[] = [];
    const A = defineService({
      inject: {},
      factory: () => {
        order.push('A');
        return { a: 1 };
      },
    });
    const B = defineService({
      inject: { a: A },
      factory: ({ a }) => {
        order.push('B');
        return { b: a.a + 1 };
      },
    });
    const C = defineService({
      inject: { a: A, b: B },
      factory: ({ a, b }) => {
        order.push('C');
        return { c: a.a + b.b };
      },
    });
    const c = new Container();
    c.register(A);
    c.register(B);
    c.register(C);
    const r = await c.resolve(C);
    assert.strictEqual(r.c, 3);
    // A must be constructed first, then B, then C
    assert.deepStrictEqual(order, ['A', 'B', 'C']);
  });

  it('five-level deep chain resolves correctly', async () => {
    const L1 = defineService({ inject: {}, factory: () => ({ n: 1 }) });
    const L2 = defineService({ inject: { p: L1 }, factory: ({ p }) => ({ n: p.n + 1 }) });
    const L3 = defineService({ inject: { p: L2 }, factory: ({ p }) => ({ n: p.n + 1 }) });
    const L4 = defineService({ inject: { p: L3 }, factory: ({ p }) => ({ n: p.n + 1 }) });
    const L5 = defineService({ inject: { p: L4 }, factory: ({ p }) => ({ n: p.n + 1 }) });
    const c = new Container();
    c.register(L1);
    c.register(L2);
    c.register(L3);
    c.register(L4);
    c.register(L5);
    const r = await c.resolve(L5);
    assert.strictEqual(r.n, 5);
  });
});

describe('DI: circular dependency detection', () => {
  it('throws CircularDependencyError for A -> B -> A cycles', async () => {
    // A direct cycle in the DI graph used to recurse into resolveInternal
    // unboundedly and blow the stack with a generic RangeError (the
    // `pending` promise cache only shortcuts *after* the recursive dep
    // walk, so a synchronous cycle never fires it).
    //
    // Container now tracks an in-progress `resolving` stack and throws a
    // readable CircularDependencyError listing the cycle.
    //
    // We can't build the cycle declaratively at defineService time (A
    // has to exist before it can appear in B.deps). Use a deferred
    // factory: create both, then patch A.deps to reference B, wiring the
    // cycle. The cycle surfaces at resolve() time, which is what we want
    // to test.
    const A: any = defineService({
      inject: {},
      factory: (deps: any) => ({ tag: 'A', b: deps?.b }),
    });
    const B: any = defineService({
      inject: { a: A },
      factory: ({ a }: any) => ({ tag: 'B', a }),
    });
    // Patch A's deps to introduce the cycle after both ServiceDefs exist.
    A.deps = { b: B };

    const c = new Container();
    c.register(A);
    c.register(B);

    await assert.rejects(
      () => c.resolve(B),
      (err: unknown) =>
        err instanceof CircularDependencyError &&
        /Circular dependency:/.test((err as Error).message) &&
        /->/.test((err as Error).message),
    );
  });
});

describe('DI: token kinds', () => {
  it('resolves by class token', async () => {
    class X {
      v = 'x';
    }
    const c = new Container();
    c.registerClass(X);
    const r = await c.resolve(X);
    assert.strictEqual(r.v, 'x');
  });

  it('resolves by abstract class token via registerFor', async () => {
    abstract class AbstractX {
      abstract read(): string;
    }
    const Impl = defineService({
      inject: {},
      factory: () => ({ read: () => 'concrete' }),
    });
    const c = new Container();
    c.register(Impl);
    c.registerFor(AbstractX as any, Impl);
    const r = await c.resolve(AbstractX as any);
    assert.strictEqual((r as any).read(), 'concrete');
  });

  it('resolves abstract class (defineAbstract) bound to concrete via registerFor', async () => {
    interface IFoo {
      foo(): number;
    }
    abstract class Foo extends defineAbstract<IFoo>('Foo') {}
    const FooImpl = defineService({
      inject: {},
      factory: () => ({ foo: () => 42 }),
    });
    const c = new Container();
    c.register(FooImpl);
    c.registerFor(Foo as any, FooImpl);
    const r = (await c.resolve(Foo as any)) as IFoo;
    assert.strictEqual(r.foo(), 42);
  });

  it('auto-instantiates unknown class tokens', async () => {
    class Unknown {
      val = 'auto';
    }
    const c = new Container();
    const r = await c.resolve(Unknown);
    assert.strictEqual(r.val, 'auto');
  });

  it('throws descriptive error for unresolvable token', async () => {
    const c = new Container();
    const bad = { notAClass: true } as any;
    await assert.rejects(
      () => c.resolve(bad),
      (err: Error) => /Unable to resolve/.test(err.message),
    );
  });

  it('resolves via provides: class auto-binding path', async () => {
    interface IStorage {
      name(): string;
    }
    abstract class AbstractStorage extends defineAbstract<IStorage>('AbstractStorage') {}
    const Impl = defineService({
      inject: {},
      provides: [AbstractStorage],
      factory: () => ({ name: () => 'memory' }),
    });
    // When provides metadata is set, getServiceProvides exposes the tokens.
    const provides = getServiceProvides(Impl);
    assert.ok(provides);
    assert.strictEqual(provides![0], AbstractStorage);
  });
});

describe('DI: idempotent resolution + singleton semantics', () => {
  it('same token resolves to same instance twice', async () => {
    class X {
      id = Math.random();
    }
    const c = new Container();
    c.registerClass(X);
    const r1 = await c.resolve(X);
    const r2 = await c.resolve(X);
    assert.strictEqual(r1, r2);
  });

  it('sibling consumers see the same dep instance', async () => {
    class D {
      id = Math.random();
    }
    const A = defineService({ inject: { d: D }, factory: ({ d }) => ({ id: d.id }) });
    const B = defineService({ inject: { d: D }, factory: ({ d }) => ({ id: d.id }) });
    const c = new Container();
    c.registerClass(D);
    c.register(A);
    c.register(B);
    const [a, b] = await Promise.all([c.resolve(A), c.resolve(B)]);
    assert.strictEqual(a.id, b.id);
  });

  it('same ServiceDef resolved under multiple tokens yields one instance', async () => {
    let count = 0;
    abstract class Abs {
      abstract v(): number;
    }
    const Impl = defineService({
      inject: {},
      factory: () => {
        count++;
        return { v: () => 1 };
      },
    });
    const c = new Container();
    c.register(Impl);
    c.registerFor(Abs as any, Impl);
    const a = await c.resolve(Impl);
    const b = await c.resolve(Abs as any);
    assert.strictEqual(a, b);
    assert.strictEqual(count, 1);
  });
});

describe('DI: registerInstance overrides', () => {
  it('uses pre-registered instance and never calls factory', async () => {
    let factoryRan = false;
    const S = defineService({
      inject: {},
      factory: () => {
        factoryRan = true;
        return { fromFactory: true };
      },
    });
    const c = new Container();
    c.register(S);
    const preset = { fromFactory: false } as any;
    c.registerInstance(S, preset);
    const r = await c.resolve(S);
    assert.strictEqual(r, preset);
    assert.strictEqual(factoryRan, false);
  });

  it('registerInstance wins over later resolve() attempts', async () => {
    class X {
      value = 'default';
    }
    const c = new Container();
    c.registerClass(X);
    // resolve first to force instantiation
    const first = await c.resolve(X);
    const custom = new X();
    custom.value = 'custom';
    c.registerInstance(X, custom);
    const second = await c.resolve(X);
    assert.strictEqual(second, custom);
    assert.notStrictEqual(first, second);
  });
});

describe('DI: SERVICE_ID and getServiceId', () => {
  it('defineService assigns unique SERVICE_IDs', () => {
    const A = defineService({ inject: {}, factory: () => ({}) });
    const B = defineService({ inject: {}, factory: () => ({}) });
    const idA = getServiceIdValue(A);
    const idB = getServiceIdValue(B);
    assert.ok(typeof idA === 'number');
    assert.ok(typeof idB === 'number');
    assert.notStrictEqual(idA, idB);
  });

  it('getServiceId returns deterministic name#id for defineService', () => {
    const S = defineService({ inject: {}, factory: () => ({}) });
    const id = getServiceId(S);
    assert.ok(typeof id === 'string');
    assert.ok(id.length > 0);
  });

  it('getServiceId falls back to class name for plain classes', () => {
    class PlainService {}
    const id = getServiceId(PlainService as any);
    assert.strictEqual(id, 'PlainService');
  });
});

describe('DI: error paths', () => {
  it('throws when a defineService returns null deps', async () => {
    const Broken: any = {
      deps: null,
      factory: () => ({}),
    };
    const c = new Container();
    c.register(Broken);
    await assert.rejects(
      () => c.resolve(Broken),
      /has no deps defined/,
    );
  });

  it('auto-instantiates a plain abstract class when not bound (TS abstract is runtime-plain)', async () => {
    // TypeScript's `abstract class` compiles to a plain class at runtime:
    // `new` works, and the Container happily auto-instantiates it with no
    // cycle detection. Document this behavior — if you want runtime
    // protection, use `defineAbstract()` which installs a throwing
    // constructor.
    abstract class MaybeImpl {
      abstract x(): number;
    }
    const S = defineService({
      inject: { n: MaybeImpl as any },
      factory: ({ n }) => ({ wrapped: n }),
    });
    const c = new Container();
    c.register(S);
    const r = await c.resolve(S);
    assert.ok(r.wrapped);
  });

  it('Service classes from defineService throw when constructed directly', () => {
    class Direct extends defineService({
      inject: {},
      factory: () => ({ ok: true }),
    }) {}
    assert.throws(() => new Direct(), /should not be instantiated directly/);
  });

  it('defineAbstract base itself (returned class) throws on new', () => {
    // The base returned by defineAbstract<T>() has a throwing constructor
    // when invoked directly. Wrapping via `abstract class X extends
    // defineAbstract<T>('X') {}` creates a SUBCLASS — and new.target on a
    // subclass is the subclass, not the defineAbstract base, so the guard
    // does not fire. That is intentional: users define concrete subclasses
    // that do extend the base, and those subclasses are meant to be the
    // token shape (not runtime-instantiable by user code normally, but the
    // throw only fires when someone news the bare defineAbstract result).
    const Raw = defineAbstract<{ x(): number }>('RawAbs');
    assert.throws(() => new (Raw as any)(), /cannot be instantiated directly/);
  });
});

describe('DI: concurrent / pending', () => {
  it('resolves concurrently without double-instantiating even with deep chain', async () => {
    let aCount = 0;
    let bCount = 0;
    const A = defineService({
      inject: {},
      factory: async () => {
        await new Promise((r) => setTimeout(r, 5));
        aCount++;
        return { a: true };
      },
    });
    const B = defineService({
      inject: { a: A },
      factory: async ({ a }) => {
        await new Promise((r) => setTimeout(r, 5));
        bCount++;
        return { b: true, parent: a };
      },
    });
    const c = new Container();
    c.register(A);
    c.register(B);
    const [a1, a2, b1, b2] = await Promise.all([
      c.resolve(A),
      c.resolve(A),
      c.resolve(B),
      c.resolve(B),
    ]);
    assert.strictEqual(aCount, 1);
    assert.strictEqual(bCount, 1);
    assert.strictEqual(a1, a2);
    assert.strictEqual(b1, b2);
    assert.strictEqual(b1.parent, a1);
  });
});

describe('DI: resolver injection', () => {
  it('factory receives a resolver that can fetch additional services', async () => {
    class Extra {
      v = 'extra';
    }
    const S = defineService({
      inject: {},
      factory: async (_deps, resolve) => {
        const extra = await resolve(Extra);
        return { extraVal: extra.v };
      },
    });
    const c = new Container();
    c.register(S);
    const r = await c.resolve(S);
    assert.strictEqual(r.extraVal, 'extra');
  });

  it('resolver.registerInstance mutates the container at resolve-time', async () => {
    class Tag {
      v = 'original';
    }
    const S = defineService({
      inject: {},
      factory: (_deps, resolve) => {
        const override = { v: 'overridden' } as any;
        (resolve as any).registerInstance!(Tag, override);
        return { ok: true };
      },
    });
    const c = new Container();
    c.register(S);
    await c.resolve(S);
    const t = await c.resolve(Tag);
    assert.strictEqual(t.v, 'overridden');
  });
});

describe('DI: cross-container isolation', () => {
  it('two Containers hold independent singletons', async () => {
    let count = 0;
    const S = defineService({
      inject: {},
      factory: () => {
        count++;
        return { n: count };
      },
    });
    const c1 = new Container();
    const c2 = new Container();
    c1.register(S);
    c2.register(S);
    const r1 = await c1.resolve(S);
    const r2 = await c2.resolve(S);
    assert.strictEqual(count, 2);
    assert.notStrictEqual(r1, r2);
    assert.notStrictEqual(r1.n, r2.n);
  });
});

describe('DI: resolveAll', () => {
  it('resolveAll instantiates every registered service', async () => {
    let aDone = false;
    let bDone = false;
    const A = defineService({
      inject: {},
      factory: () => {
        aDone = true;
        return {};
      },
    });
    const B = defineService({
      inject: {},
      factory: () => {
        bDone = true;
        return {};
      },
    });
    const c = new Container();
    c.register(A);
    c.register(B);
    await c.resolveAll();
    assert.ok(aDone);
    assert.ok(bDone);
  });

  it('resolveAll is idempotent', async () => {
    let n = 0;
    const S = defineService({
      inject: {},
      factory: () => {
        n++;
        return {};
      },
    });
    const c = new Container();
    c.register(S);
    await c.resolveAll();
    await c.resolveAll();
    await c.resolveAll();
    assert.strictEqual(n, 1);
  });
});

describe('DI: mixed deps (class + defineService + abstract)', () => {
  it('mixes defineService and class deps in one factory', async () => {
    class Plain {
      val = 7;
    }
    const S1 = defineService({ inject: {}, factory: () => ({ s1: 'a' }) });
    const Mixed = defineService({
      inject: { p: Plain, s: S1 },
      factory: ({ p, s }) => ({ combined: `${p.val}-${s.s1}` }),
    });
    const c = new Container();
    c.registerClass(Plain);
    c.register(S1);
    c.register(Mixed);
    const r = await c.resolve(Mixed);
    assert.strictEqual(r.combined, '7-a');
  });
});
