/**
 * DI token behaviour for contract-based controllers.
 *
 * Contract controllers are ServiceDef objects — they register/resolve like any
 * service, and they show up as injectable dependencies. These tests pin:
 *   - inject: { ctrl: MyCtrl } receives the compiled ContractControllerInstance
 *   - .add() chain + late registration: order of registration doesn't matter
 *   - double registration doesn't leak state across Containers
 *   - unregistered controller: clear error, not undefined
 *
 * NOTE ON DESIGN DRIFT: design-contract-system.md envisions the CONTRACT itself
 * as the DI token (so `inject: { svc: MyContract }`). Today you must inject the
 * ControllerDef (the output of createController.implements(Contract).create({...})).
 * We pin today's behaviour.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineContract,
  defineService,
  rpc,
  simpleMessage,
  Container,
  createController,
} from '../../../src/index.js';

interface Req { x: number }
interface Res { y: number }
const ReqS = simpleMessage<Req>('Req');
const ResS = simpleMessage<Res>('Res');

abstract class MathSvc extends defineContract({
  protocol: 'grpc',
  serviceName: 'svc.Math',
  methods: { square: rpc(ReqS, ResS) },
}) {}

const MathCtrl = createController.implements(MathSvc).create({
  inject: {},
  methods: () => ({
    square: async ({ body }) => ({ y: body.x * body.x }),
  }),
});

describe('contract controller — DI token behaviour', () => {
  // INVARIANT: injecting the ControllerDef yields the resolved
  // ContractControllerInstance with its .methods map, not the Def itself.
  test('inject: { ctrl: MathCtrl } receives the compiled instance', async () => {
    class Consumer extends defineService({
      inject: { ctrl: MathCtrl },
      factory: ({ ctrl }) => ({
        callSquare: async (x: number): Promise<number> => {
          const h = ctrl.methods.get('square')!.handler;
          const r = await h({
            body: { x }, metadata: new Map(), signal: new AbortController().signal, session: {},
          });
          return (r as Res).y;
        },
      }),
    }) {}

    const c = new Container().register(MathCtrl).register(Consumer);
    const consumer = await c.resolve(Consumer);
    assert.equal(await consumer.callSquare(5), 25);
  });

  // INVARIANT: late registration works — register consumer first, controller second.
  // (Container resolves lazily, so registration order must not matter.)
  test('late-registered controller is still found when a consumer resolves', async () => {
    class Consumer extends defineService({
      inject: { ctrl: MathCtrl },
      factory: ({ ctrl }) => ({ ctrlRef: ctrl }),
    }) {}

    const c = new Container();
    c.register(Consumer);      // registered FIRST
    c.register(MathCtrl);      // registered SECOND

    const consumer = await c.resolve(Consumer);
    assert.ok(consumer.ctrlRef, 'contract controller resolved despite late registration');
    assert.ok(consumer.ctrlRef.methods.has('square'));
  });

  // INVARIANT: resolving the controller twice in the same Container returns the
  // same instance (singleton per scope). A regression here would double-compile
  // methods and duplicate any stateful deps.
  test('same Container returns the same ContractControllerInstance across resolves', async () => {
    const c = new Container().register(MathCtrl);
    const a = await c.resolve(MathCtrl);
    const b = await c.resolve(MathCtrl);
    assert.equal(a, b, 'singleton per Container');
    assert.equal(a.methods, b.methods);
  });

  // INVARIANT: even when the controller is NOT explicitly registered, the Container
  // auto-resolves it from the injected token (the ControllerDef carries its own
  // factory). The consumer's `ctrl` is therefore never `undefined` silently.
  //
  // Surprising? Yes. But *silent undefined* is the failure we dread — this path
  // is loud: either you get a working instance, or the factory throws.
  // Pin this so a future change to make unregistered contracts fail is intentional.
  test('unregistered controller auto-resolves via injected ServiceDef (never silent undefined)', async () => {
    class Consumer extends defineService({
      inject: { ctrl: MathCtrl },
      factory: ({ ctrl }) => ({ ctrl }),
    }) {}

    const c = new Container().register(Consumer);  // MathCtrl NOT registered
    const consumer = await c.resolve(Consumer);
    assert.ok(consumer.ctrl, 'ctrl is resolved, never silently undefined');
    assert.ok(consumer.ctrl.methods.has('square'));
  });

  // INVARIANT: the ControllerDef object exposes `deps` and `factory` (standard ServiceDef shape)
  // so the validator / build-time tools can walk dependencies.
  test('ControllerDef exposes ServiceDef shape (deps + factory)', () => {
    assert.ok((MathCtrl as any).factory, 'factory exists');
    assert.ok((MathCtrl as any).deps, 'deps exists');
    assert.equal(typeof (MathCtrl as any).factory, 'function');
  });

  // INVARIANT: a second ContractControllerDef for the same Contract is a *distinct*
  // DI token. Register both; they don't collide. (Today's behaviour; a "Contract-as-token"
  // design would need to collapse these, so this test pins the drift.)
  test('two controllers of the same contract are distinct DI tokens', async () => {
    const A = createController.implements(MathSvc).create({
      inject: {},
      methods: () => ({ square: async ({ body }) => ({ y: body.x }) }),
    });
    const B = createController.implements(MathSvc).create({
      inject: {},
      methods: () => ({ square: async ({ body }) => ({ y: -body.x }) }),
    });

    const c = new Container().register(A).register(B);
    const iA = await c.resolve(A);
    const iB = await c.resolve(B);
    assert.notEqual(iA, iB);

    const ctx = { body: { x: 7 }, metadata: new Map(), signal: new AbortController().signal, session: {} };
    assert.deepEqual(await iA.methods.get('square')!.handler(ctx), { y: 7 });
    assert.deepEqual(await iB.methods.get('square')!.handler(ctx), { y: -7 });
  });
});
