/**
 * Sub-app scoping (CORE_PHILOSOPHY §9).
 *
 * A `JustScale()` with `.requires(...)` IS a sub-app — it cannot build
 * and run standalone; it must be `.add()`-ed into a parent that provides
 * every required token. Per the design:
 *
 *   - Sub-app's own `.add()`s land in its own container, not the parent's.
 *   - Parent's controllers don't leak into the sub-app's `controllers()`.
 *   - Nested sub-apps each own their scope — A → B → C, each with its
 *     own container + reflection surface.
 *
 * The lean-forward property: each scope is introspectable the same way,
 * with no privileged tools. Tests here pin that property from the most
 * basic (add lands locally) up to multi-level nesting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService, defineAbstract } from '../../src/core/service.js';
import { createController } from '../../src/core/controller.js';
import { bindService } from '../../src/builder/builder.js';
import { DependencyError } from '../../src/builder/validation.js';
import type { RouteDef } from '../../src/builder/types.js';

// Local HTTP-like stub — core is transport-agnostic, so we construct a
// RouteDef shape directly instead of importing @justscale/http.
function Get(path: string, handler: (ctx: any) => any): RouteDef<any, any, any> {
  return {
    path,
    steps: [],
    responseSchemas: new Map(),
    handler,
    method: 'GET',
  } as any;
}

abstract class AbstractDb extends defineAbstract<{
  query(): string[]
}>('AbstractDb') {}

const MemoryDb = defineService({
  inject: {},
  factory: () => ({ query: () => ['row'] }),
});

describe('sub-app scoping', () => {
  it('a sub-app with .requires(X): .compile() returns a branded error type at TS-level', () => {
    // INVARIANT: declaring .requires(X) makes the builder a sub-app
    // that can't run alone. `SubApp.compile()` is typed as
    // `CannotCompileSubAppError<T>` — callers get a type error when
    // using it. Runtime still returns the compiled value because the
    // parent's compose path reuses the same sub-app instance.
    //
    // Why we can't assert a runtime throw on resolve(AbstractDb):
    // see the todo test below — `defineAbstract`'s new.target guard
    // only fires for direct instantiation, so a subclass resolves to
    // an empty object rather than rejecting.
    const SubApp = JustScale().requires(AbstractDb).build();

    const app = SubApp.compile();
    assert.ok(app, 'runtime compile returns a value');
    // @ts-expect-error — compile() returns branded CannotCompileSubAppError, no container field
    assert.ok(app.container, 'and a container');
  });

  it('sub-app composed under a parent that provides X: works', async () => {
    // INVARIANT: the whole point of sub-apps — a partial graph becomes
    // whole when its requires are satisfied by the enclosing scope.
    const SubApp = JustScale().requires(AbstractDb).build();

    const parent = JustScale()
      .add(MemoryDb)
      .add(bindService(AbstractDb, MemoryDb))
      .add(SubApp)
      .build();
    const parentApp = parent.compile();
    await parentApp.ready;

    // Sub-app's container resolves the bridged AbstractDb successfully.
    const subContainer = (SubApp as any).container;
    const db = await subContainer.resolve(AbstractDb);
    assert.deepStrictEqual(db.query(), ['row']);
  });

  it('sub-app controllers are NOT in parent.container.controllers', async () => {
    // INVARIANT: a sub-app's controllers register into its own scope.
    // Parent's `controllers` array must only include controllers the
    // parent directly added. Leaking would mean a tenant sub-app's
    // admin routes appear on the root app's OpenAPI spec — exactly
    // what the scoping design prevents.
    const ParentCtrl = createController({
      inject: {},
      routes: () => ({
        p: Get('/parent', () => ({})) as any,
      }),
    });
    const SubCtrl = createController({
      inject: {},
      routes: () => ({
        s: Get('/sub', () => ({})) as any,
      }),
    });

    const SubApp = JustScale().add(SubCtrl).build();
    const parent = JustScale().add(ParentCtrl).add(SubApp).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const parentCtrls = parentApp.controllers;
    // Parent's controller list has 1 item — the parent controller.
    assert.strictEqual(parentCtrls.length, 1, 'parent only sees its own controllers');

    // Sub-app's controllers live on the sub-app's container.
    const subCtrls = (SubApp as any).controllers;
    assert.strictEqual(subCtrls.length, 1, 'sub-app sees its own controller');
    assert.notStrictEqual(
      parentCtrls[0],
      subCtrls[0],
      'parent and sub-app controllers are distinct instances',
    );
  });

  it('sub-app has its own container distinct from parent', async () => {
    // INVARIANT: identity of container objects is meaningful — getContainer()
    // inside handlers branches on it, ref resolution is scope-aware, etc.
    const SubApp = JustScale().add(MemoryDb).build();
    const parent = JustScale().add(SubApp).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const subContainer = (SubApp as any).container;
    assert.notStrictEqual(
      subContainer,
      parentApp.container,
      'sub-app container is a distinct object from parent container',
    );
  });

  it('A → B → C nesting: each scope gets its own container', async () => {
    // INVARIANT: nesting must be uniform — not special-cased at depth 1.
    // Each level gets its own container; containers are distinct objects.
    //
    // NOTE: container scope isolation is tested here by comparing identity
    // of the container objects at each depth. Resolving arbitrary
    // services from a parent's container doesn't fail the way you'd
    // expect — `Container.resolve(AbstractClass)` falls through to
    // `new AbstractClass()` when no binding exists, and `defineAbstract`
    // only throws for DIRECT instantiation (new.target check). A user's
    // `abstract class MyAbstract extends defineAbstract()` subclass
    // resolves to an empty instance instead of throwing. That's a
    // separate bug — see todo below.
    abstract class AbstractLeaf extends defineAbstract<{
      leaf(): string
    }>('AbstractLeaf') {}

    const LeafImpl = defineService({
      inject: {},
      factory: () => ({ leaf: () => 'leaf' }),
    });

    const C = JustScale().add(LeafImpl).add(bindService(AbstractLeaf, LeafImpl)).build();
    const B = JustScale().add(C).build();
    const A = JustScale().add(B).build();
    const root = A.compile();
    await root.ready;

    const aCont = (A as any).container;
    const bCont = (B as any).container;
    const cCont = (C as any).container;

    // Scope isolation: distinct container identity at each depth.
    assert.notStrictEqual(aCont, bCont, 'A ≠ B');
    assert.notStrictEqual(bCont, cCont, 'B ≠ C');
    assert.notStrictEqual(aCont, cCont, 'A ≠ C');

    // Only C's binding gives the functional impl.
    const cLeaf = await cCont.resolve(AbstractLeaf);
    assert.strictEqual(cLeaf.leaf(), 'leaf');
  });

  it('todo: Container.resolve(AbstractClass) with no binding returns empty instance instead of throwing', async () => {
    // BUG: `defineAbstract`'s new.target guard only fires for DIRECT
    // instantiation — a user's `abstract class X extends defineAbstract()`
    // subclass is a different constructor, so the guard never triggers.
    // When a container has no binding for X, resolveInternal falls
    // through to `new X()` which silently produces an empty object.
    // Downstream code then hits "x.method is not a function" far from
    // the root cause.
    //
    // todo: Container.resolve should detect "abstract class, no binding"
    //   and throw a "no provider for AbstractX in this scope" error.
    //   Could key off a symbol stamped by defineAbstract (same as
    //   CONTRIBUTION_MARKER).
    abstract class AbstractUnbound extends defineAbstract<{
      method(): string
    }>('AbstractUnbound') {}

    const app = JustScale().build().compile();
    await app.ready;

    const result = await app.container.resolve(AbstractUnbound);
    // BUG: we get back an empty instance, not an error.
    assert.ok(result, 'container returns something');
    assert.strictEqual(
      typeof (result as any).method,
      'undefined',
      'no method present — empty subclass instance',
    );
  });

  it('parent build fails when a sub-app\'s require isn\'t provided anywhere in the parent', () => {
    // INVARIANT: parent `.build()` aggregates sub-app requires into its
    // own dep check (`additionalRequires` in validation.ts). Missing a
    // require surfaces here, not deferred to runtime.
    const SubApp = JustScale().requires(AbstractDb).build();

    assert.throws(
      // @ts-expect-error — parent's TProvided missing AbstractDb
      () => JustScale().add(SubApp).build(),
      (err: unknown) => {
        assert.ok(err instanceof DependencyError, 'must be DependencyError');
        assert.match((err as Error).message, /required by sub-app/i);
        return true;
      },
    );
  });
});
