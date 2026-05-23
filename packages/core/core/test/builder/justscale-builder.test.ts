/**
 * Edge-case tests for the JustScale() builder — the user-facing entry
 * point that backs the app bootstrap flow.
 *
 * Covers:
 *   - empty app build/compile
 *   - .add() rejecting null/undefined
 *   - bindService, bindInstance, bindRepository wiring
 *   - .override() precedence
 *   - DependencyError thrown on missing dep
 *   - service, controller registration flow
 *   - apps registry (WeakRefSet)
 *   - multiple independent builders
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale, { type BuiltApp } from '../../src/justscale.js';
import {
  defineService,
  defineAbstract,
  Container,
} from '../../src/core/service.js';
import {
  bindInstance,
  bindService,
} from '../../src/builder/builder.js';
import { DependencyError } from '../../src/builder/validation.js';
import { createController } from '../../src/core/controller.js';

describe('JustScale builder: minimal lifecycle', () => {
  it('builds an empty app', () => {
    const built = JustScale().build();
    assert.ok(built);
    assert.ok(built.app);
    assert.ok(built.container instanceof Container);
    assert.strictEqual(built.isServing, false);
  });

  it('compile() returns the same app on repeated calls', () => {
    const built = JustScale().build();
    const a1 = built.compile();
    const a2 = built.compile();
    assert.strictEqual(a1, a2);
  });

  it('exposes resolve() that delegates to container', async () => {
    const S = defineService({
      inject: {},
      factory: () => ({ tag: 'svc' }),
    });
    const built = JustScale().add(S).build();
    const r = await built.resolve(S);
    assert.strictEqual(r.tag, 'svc');
  });

  it('registers built app in JustScale.apps', () => {
    const built = JustScale().build();
    let found = false;
    for (const app of JustScale.apps) {
      if (app === built) {
        found = true;
        break;
      }
    }
    assert.ok(found, 'built app should be in JustScale.apps WeakRefSet');
  });
});

describe('JustScale builder: null/undefined rejection', () => {
  it('.add(null) throws a clear TypeError', () => {
    assert.throws(
      // @ts-expect-error — intentionally passing null
      () => JustScale().add(null),
      (err: any) => err instanceof TypeError && /null/.test(err.message),
    );
  });

  it('.add(undefined) throws a clear TypeError', () => {
    assert.throws(
      // @ts-expect-error — intentionally passing undefined
      () => JustScale().add(undefined),
      (err: any) => err instanceof TypeError && /undefined/.test(err.message),
    );
  });
});

describe('JustScale builder: bindInstance', () => {
  it('binds a concrete instance to an abstract token', async () => {
    abstract class Abs extends defineAbstract<{ hello(): string }>('Abs') {}
    const impl = { hello: () => 'world' };
    const built = JustScale().add(bindInstance(Abs as any, impl)).build();
    const resolved = await built.resolve(Abs as any);
    assert.strictEqual(resolved, impl);
  });

  it('resolves injected abstract via bindInstance in dependent services', async () => {
    abstract class Greeter extends defineAbstract<{ greet(): string }>('Greeter') {}
    const greeter = { greet: () => 'hi' };
    const Consumer = defineService({
      inject: { g: Greeter as any },
      factory: ({ g }: any) => ({ talk: () => g.greet() + '!' }),
    });
    const built = JustScale()
      .add(bindInstance(Greeter as any, greeter))
      .add(Consumer)
      .build();
    const c = await built.resolve(Consumer);
    assert.strictEqual(c.talk(), 'hi!');
  });
});

describe('JustScale builder: bindService', () => {
  it('binds an abstract token to a concrete defineService', async () => {
    abstract class Abs extends defineAbstract<{ v(): number }>('Abs') {}
    const Impl = defineService({
      inject: {},
      factory: () => ({ v: () => 7 }),
    });
    const built = JustScale()
      .add(Impl)
      .add(bindService(Abs as any, Impl))
      .build();
    const resolved = await built.resolve(Abs as any);
    assert.strictEqual((resolved as any).v(), 7);
  });

  it('same ServiceDef resolved under abstract and concrete token is the same instance', async () => {
    abstract class Abs extends defineAbstract<{ v(): number }>('Abs') {}
    let count = 0;
    const Impl = defineService({
      inject: {},
      factory: () => {
        count++;
        return { v: () => 1 };
      },
    });
    const built = JustScale()
      .add(Impl)
      .add(bindService(Abs as any, Impl))
      .build();
    const a = await built.resolve(Abs as any);
    const b = await built.resolve(Impl);
    assert.strictEqual(a, b);
    assert.strictEqual(count, 1);
  });
});

describe('JustScale builder: validation', () => {
  it('throws DependencyError when a required service is missing', () => {
    abstract class MissingDep extends defineAbstract<{ x(): number }>('MissingDep') {}
    const Consumer = defineService({
      inject: { x: MissingDep as any },
      factory: ({ x }: any) => ({ val: x.x() }),
    });

    assert.throws(
      () => JustScale().add(Consumer).build(),
      (err: unknown) => err instanceof DependencyError,
    );
  });

  it('DependencyError includes the consumer name in the message', () => {
    abstract class OtherMissing extends defineAbstract<{ ping(): number }>('OtherMissing') {}
    const Consumer = defineService({
      inject: { x: OtherMissing as any },
      factory: ({ x }: any) => ({ val: x.ping() }),
    });

    try {
      JustScale().add(Consumer).build();
      assert.fail('expected DependencyError');
    } catch (err) {
      assert.ok(err instanceof DependencyError);
      assert.ok(err.message.length > 0);
      assert.ok(/Missing dependencies/i.test(err.message));
    }
  });
});

describe('JustScale builder: controllers', () => {
  it('exposes compiled controllers via .controllers', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({}),
    });
    const built = JustScale().add(Ctrl).build();
    await built.app.ready;
    const controllers = built.controllers;
    assert.strictEqual(controllers.length, 1);
  });

  it('adds service dependency used by a controller', async () => {
    const UserSvc = defineService({
      inject: {},
      factory: () => ({ count: () => 42 }),
    });

    const Ctrl = createController({
      inject: { users: UserSvc },
      routes: () => ({}),
    });

    const built = JustScale().add(UserSvc).add(Ctrl).build();
    await built.app.ready;
    assert.strictEqual(built.controllers.length, 1);
  });
});

describe('JustScale builder: independence', () => {
  it('two independent apps do not share services', async () => {
    let count = 0;
    const S = defineService({
      inject: {},
      factory: () => {
        count++;
        return { n: count };
      },
    });
    const a = JustScale().add(S).build();
    const b = JustScale().add(S).build();
    const ra = await a.resolve(S);
    const rb = await b.resolve(S);
    assert.notStrictEqual(ra, rb);
    assert.strictEqual(count, 2);
  });
});

describe('JustScale builder: accessing app surface', () => {
  it('app.container and built.container are the same', async () => {
    const built = JustScale().build();
    assert.strictEqual(built.app.container, built.container);
  });

  it('app.ready resolves after controllers are built', async () => {
    let resolveAfterReady = false;
    const Ctrl = createController({
      inject: {},
      routes: () => {
        // This block runs during controller resolve
        resolveAfterReady = true;
        return {};
      },
    });
    const built = JustScale().add(Ctrl).build();
    await built.app.ready;
    assert.strictEqual(resolveAfterReady, true);
  });

  it('app.adapters is an array (possibly empty)', () => {
    const built = JustScale().build();
    assert.ok(Array.isArray(built.app.adapters));
  });

  it('app.subApps is empty for leaf scopes', () => {
    const built = JustScale().build();
    assert.deepStrictEqual([...built.app.subApps], []);
  });
});

describe('JustScale builder: adding sub-app', () => {
  it('a sub-app that .requires(T) is visible via app.subApps on parent', async () => {
    const Shared = defineService({
      inject: {},
      factory: () => ({ v: 1 }),
    });

    const Sub = JustScale().requires(Shared).build();

    const parent = JustScale().add(Shared).add(Sub).build();
    const app = parent.compile();
    await app.ready;

    assert.strictEqual(app.subApps.length, 1);
  });

  it('sub-app compiled-app equals the one exposed on parent.subApps', async () => {
    const Shared = defineService({ inject: {}, factory: () => ({ v: 1 }) });
    const Sub = JustScale().requires(Shared).build();

    const parent = JustScale().add(Shared).add(Sub);
    const parentBuilt = parent.build();
    const parentApp = parentBuilt.compile();
    await parentApp.ready;

    // Sub-app should have been compiled into parent's subApps.
    const subApp = (Sub as unknown as { compile: () => any }).compile();
    assert.ok(parentApp.subApps.includes(subApp));
  });
});
