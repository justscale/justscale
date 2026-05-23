/**
 * Contract + middleware + guards.
 *
 * The memory (design-contract-system.md) implies contract methods support
 * .use(mw) and .guard(g) like HTTP routes. The shipped implementation of
 * CompiledRpcMethod always emits empty middleware / guard arrays —
 * see packages/core/core/src/core/controller.ts (CompiledRpcMethod).
 *
 * These tests pin the CURRENT reality so a future intentional wiring is a
 * deliberate behaviour change, not an accident. Each test names what is
 * missing so upgraders know what to look for.
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

interface Req { n: number }
interface Res { doubled: number }
const ReqS = simpleMessage<Req>('Req');
const ResS = simpleMessage<Res>('Res');

abstract class Doubler extends defineContract({
  protocol: 'grpc',
  serviceName: 'svc.Doubler',
  methods: { double: rpc(ReqS, ResS) },
}) {}

describe('contract middleware + guard wiring (current state)', () => {
  // INVARIANT: the compiled method carries empty `middlewares` and `guards` arrays.
  // No middleware chain runs before the handler. A silent "middleware skipped"
  // would break auth/logging/quota policies; this test makes the absence explicit.
  test('CompiledRpcMethod.middlewares and .guards default to empty arrays', async () => {
    const Ctrl = createController.implements(Doubler).create({
      inject: {},
      methods: () => ({ double: async ({ body }) => ({ doubled: body.n * 2 }) }),
    });
    const c = new Container().register(Ctrl);
    const inst = await c.resolve(Ctrl);
    const m = inst.methods.get('double')!;
    assert.ok(Array.isArray(m.middlewares), 'middlewares is an array');
    assert.equal(m.middlewares.length, 0, 'no middleware is applied today');
    assert.ok(Array.isArray(m.guards));
    assert.equal(m.guards.length, 0, 'no guard is applied today');
  });

  // INVARIANT: the handler is called *directly* — there is no intermediate
  // pipeline. If someone adds a `before`/`after` hook to the codebase without
  // wiring it through CompiledRpcMethod, that hook will NOT run for contract
  // handlers. This test guarantees that wiring would be observable.
  test('handler is invoked with the raw context — no wrapper function', async () => {
    let calls = 0;
    const Ctrl = createController.implements(Doubler).create({
      inject: {},
      methods: () => ({
        double: async ({ body, metadata, signal, session }) => {
          calls++;
          // Verify raw RpcContext shape is passed unchanged
          assert.ok(metadata instanceof Map, 'metadata is a Map');
          assert.ok(signal && typeof signal.aborted === 'boolean', 'AbortSignal present');
          assert.ok(session !== undefined, 'session slot present');
          return { doubled: body.n * 2 };
        },
      }),
    });
    const c = new Container().register(Ctrl);
    const inst = await c.resolve(Ctrl);
    const r = await inst.methods.get('double')!.handler({
      body: { n: 21 },
      metadata: new Map([['x-user', 'alice']]),
      signal: new AbortController().signal,
      session: { user: 'alice' },
    });
    assert.deepEqual(r, { doubled: 42 });
    assert.equal(calls, 1);
  });

  // INVARIANT: dependencies injected at the controller level *are* available inside
  // the handler. If DI stopped reaching handlers, guards/middleware would need to
  // fill in — but today the only path is direct injection, so we prove it works.
  test('deps are closed over and visible to every method handler', async () => {
    class Counter extends defineService({
      inject: {},
      factory: () => {
        let n = 0;
        return { inc: () => ++n, value: () => n };
      },
    }) {}

    const Ctrl = createController.implements(Doubler).create({
      inject: { counter: Counter },
      methods: ({ counter }) => ({
        double: async ({ body }) => {
          counter.inc();
          return { doubled: body.n * 2 };
        },
      }),
    });
    const c = new Container().register(Counter).register(Ctrl);
    const inst = await c.resolve(Ctrl);
    const counter = await c.resolve(Counter);

    const ctx = { body: { n: 1 }, metadata: new Map(), signal: new AbortController().signal, session: {} };
    await inst.methods.get('double')!.handler(ctx);
    await inst.methods.get('double')!.handler(ctx);
    await inst.methods.get('double')!.handler(ctx);
    assert.equal(counter.value(), 3, 'each call reaches the injected counter');
  });

  // INVARIANT: the AbortSignal propagation is caller-driven. If the handler
  // wants cooperative cancellation, it must check ctx.signal itself — nothing
  // in the compiler/contract path short-circuits.
  test('AbortSignal is passed through, not consumed, by the contract layer', async () => {
    const Ctrl = createController.implements(Doubler).create({
      inject: {},
      methods: () => ({
        double: async ({ body, signal }) => {
          if (signal.aborted) throw new Error('aborted');
          return { doubled: body.n * 2 };
        },
      }),
    });
    const c = new Container().register(Ctrl);
    const inst = await c.resolve(Ctrl);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      async () => inst.methods.get('double')!.handler({
        body: { n: 10 },
        metadata: new Map(),
        signal: ac.signal,
        session: {},
      }),
      /aborted/,
    );
  });
});
