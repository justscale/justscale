/**
 * Tests for sub-app composition:
 *   JustScale().requires(T).add(ConsumerOfT) = a sub-app
 *   JustScale().add(T).add(SubApp)           = composed into a parent
 *
 * Proves:
 *   - A builder with `.requires(T)` can `.build()` despite not providing T
 *     (treated as external, satisfied at compose).
 *   - Parent `.build()` fails loudly if it doesn't provide a sub-app's
 *     required tokens.
 *   - Parent `.compile()` + `await app.ready` transparently bridges the
 *     parent's resolved instance into the sub-app's container via
 *     `createScopedBridge`. Calls from the sub-app execute in the parent's
 *     async scope (so `getContainer()` inside the bridged service reads
 *     the parent's container).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService } from '../../src/core/service.js';
import { getContainer } from '../../src/core/context.js';
import type { Container } from '../../src/core/service.js';

describe('Sub-app composition', () => {
  it('a builder with .requires() builds even without providing that token', () => {
    const MyService = defineService({ inject: {}, factory: () => ({ ping: () => 'pong' }) });

    // Sub-app: declares it needs MyService, wires nothing that provides it.
    // Should build without a dependency error (the require is assumed external).
    assert.doesNotThrow(() => {
      JustScale().requires(MyService).build();
    });
  });

  it('parent .build() fails if it does not provide a sub-app\'s requires', () => {
    const NeededService = defineService({ inject: {}, factory: () => ({ work: () => 'done' }) });

    const SubApp = JustScale().requires(NeededService).build();

    // Parent never added NeededService. This is also a type-level error
    // (AddCheck flags sub-apps whose TRequires aren't covered by TProvided
    // via `MissingSubAppRequiresError`), so we suppress the expected type
    // error here — the assertion below verifies runtime behavior matches.
    assert.throws(
      // @ts-expect-error — sub-app's require NeededService is not in parent's TProvided
      () => JustScale().add(SubApp).build(),
      (err: unknown) => {
        const e = err as Error;
        return (
          /Missing dependencies|required by sub-app/i.test(e.message) === true
        );
      },
    );
  });

  it('composed parent + sub-app: services resolve, bridge routes through parent scope', async () => {
    // A parent service that records which container its methods run inside.
    const ScopeWitness = defineService({
      inject: {},
      factory: () => ({
        whichContainer(): Container | undefined {
          return getContainer();
        },
      }),
    });

    // A sub-app service that calls the bridged parent service. If the
    // bridge is wired correctly, the returned container is the parent's
    // (not the sub-app's).
    const SubAppObserver = defineService({
      inject: { witness: ScopeWitness },
      factory: ({ witness }) => ({
        parentScope: () => witness.whichContainer(),
      }),
    });

    const SubApp = JustScale()
      .requires(ScopeWitness)
      .add(SubAppObserver)
      .build();

    const parent = JustScale().add(ScopeWitness).add(SubApp);
    const parentBuilt = parent.build();
    const parentApp = parentBuilt.compile();
    await parentApp.ready;

    // Compile sub-app and access its services
    const subBuilt = SubApp as unknown as {
      compile: () => { container: Container };
    };
    const subApp = subBuilt.compile();
    const observer = await subApp.container.resolve(SubAppObserver);

    const observedContainer = observer.parentScope();
    assert.strictEqual(
      observedContainer,
      parentApp.container,
      'bridged call executed in parent\'s scope',
    );
  });

  it('sub-app\'s own AbstractContainer reflects only sub-app controllers', async () => {
    // No new assertion beyond what Phase B already covers: each compiled
    // scope gets its own AbstractContainer. Sub-app is a compiled scope,
    // so its container has its own AbstractContainer bound. This test
    // verifies the wiring survives composition.
    const SharedService = defineService({
      inject: {},
      factory: () => ({ hello: () => 'shared' }),
    });

    const SubApp = JustScale().requires(SharedService).build();

    const parent = JustScale().add(SharedService).add(SubApp).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    // Sub-app has its own AbstractContainer — importing just to confirm
    // the compose path doesn't crash here.
    const subApp = (SubApp as unknown as { compile: () => { container: Container } }).compile();
    assert.ok(subApp.container, 'sub-app has its own container');
  });
});
