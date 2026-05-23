/**
 * defineContract() — identity, metadata, instantiation refusal.
 *
 * Every assertion here pins a property that silent failure would hurt:
 *   - metadata present and shaped right: generators & adapters rely on it
 *   - CONTRACT_ID unique + monotonic: cross-module matching breaks otherwise
 *   - direct instantiation throws: contracts are interfaces, not classes
 *   - two controllers implementing same contract stay isolated per Container
 *
 * NOTE ON DESIGN DRIFT (design-contract-system.md):
 * The memory says "contracts ARE controllers" via `createController(Contract, impl)`.
 * The actual code ships `createController.implements(Contract).create({ inject, methods })`
 * and contracts carry RPC methods (not HTTP routes). Tests pin the shipped API, not the
 * aspirational one. See the final report for divergence list.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineContract,
  rpc,
  simpleMessage,
  Container,
  createController,
  CONTRACT_METADATA,
  CONTRACT_ID,
  getContractMetadata,
} from '../../../src/index.js';

interface Req { name: string }
interface Res { message: string }

const ReqSchema = simpleMessage<Req>('Req');
const ResSchema = simpleMessage<Res>('Res');

abstract class Greeter extends defineContract({
  protocol: 'grpc',
  serviceName: 'svc.Greeter',
  methods: { hello: rpc(ReqSchema, ResSchema) },
}) {}

abstract class Farewell extends defineContract({
  protocol: 'grpc',
  serviceName: 'svc.Farewell',
  methods: { bye: rpc(ReqSchema, ResSchema) },
}) {}

describe('defineContract basics', () => {
  // INVARIANT: metadata is attached under well-known symbols and preserves config.
  test('contract class carries CONTRACT_METADATA with protocol, serviceName, and methods', () => {
    const meta = (Greeter as any)[CONTRACT_METADATA];
    assert.equal(meta.protocol, 'grpc');
    assert.equal(meta.serviceName, 'svc.Greeter');
    assert.ok(meta.methods.hello, 'method retained');
    assert.equal(meta.methods.hello.streaming, 'unary');
    assert.equal(meta.methods.hello.input, ReqSchema);
    assert.equal(meta.methods.hello.output, ResSchema);
  });

  // INVARIANT: getContractMetadata() is the public accessor; failure is loud.
  test('getContractMetadata() returns same object; throws on non-contract', () => {
    assert.equal(getContractMetadata(Greeter as any), (Greeter as any)[CONTRACT_METADATA]);
    assert.throws(() => getContractMetadata({} as any), /Not a valid contract/);
  });

  // INVARIANT: CONTRACT_ID is globally unique and monotonic. If two contracts share
  // an ID, cross-module matching (used for remote lookup) silently picks the wrong one.
  test('each contract gets a unique, monotonically increasing CONTRACT_ID', () => {
    const a = (Greeter as any)[CONTRACT_ID] as number;
    const b = (Farewell as any)[CONTRACT_ID] as number;
    assert.equal(typeof a, 'number');
    assert.equal(typeof b, 'number');
    assert.notEqual(a, b);
    assert.ok(b > a, 'IDs increase (contracts defined in source order)');
  });

  // INVARIANT: contracts are abstract. Construction is a programming error.
  test('direct instantiation throws a helpful error naming the contract', () => {
    assert.throws(
      () => new (Greeter as any)(),
      /svc\.Greeter.*cannot be instantiated directly/,
    );
  });

  // INVARIANT: two identically-shaped contracts do NOT share metadata identity.
  // A structural equality bug would let a wrong impl bind under the right name.
  test('two contracts with same serviceName still have distinct metadata objects and IDs', () => {
    abstract class G1 extends defineContract({
      protocol: 'grpc', serviceName: 'dup.Svc', methods: { m: rpc(ReqSchema, ResSchema) },
    }) {}
    abstract class G2 extends defineContract({
      protocol: 'grpc', serviceName: 'dup.Svc', methods: { m: rpc(ReqSchema, ResSchema) },
    }) {}
    const m1 = (G1 as any)[CONTRACT_METADATA];
    const m2 = (G2 as any)[CONTRACT_METADATA];
    assert.notEqual(m1, m2, 'metadata objects are NOT shared');
    assert.notEqual((G1 as any)[CONTRACT_ID], (G2 as any)[CONTRACT_ID]);
  });

  // INVARIANT: createController.implements() binds to its contract reference.
  // The returned ControllerDef exposes that contract publicly.
  test('createController.implements().create() exposes the contract it was bound to', async () => {
    const Ctrl = createController
      .implements(Greeter)
      .create({
        inject: {},
        methods: () => ({ hello: async ({ body }) => ({ message: `hi ${body.name}` }) }),
      });

    assert.equal((Ctrl as any).contract, Greeter, 'def.contract is the same reference');
    assert.equal((Ctrl as any)[Symbol.for('justscale:contractController')], true);
  });

  // INVARIANT: the contract class is NOT a valid DI token today.
  // The Container falls back to `new token()` for unregistered classes, which
  // hits the contract's "cannot be instantiated directly" throw. A silent default
  // (e.g. returning undefined) would let wrong-impl bugs sneak through. Pin the throw.
  //
  // (design-contract-system.md envisions Contract-as-token; this test documents the
  //  current mismatch, not endorsement.)
  test('resolving an unbound contract class surfaces a loud error', async () => {
    const container = new Container();
    await assert.rejects(
      container.resolve(Greeter as any),
      /cannot be instantiated directly/,
      'instantiation-refusal surfaces from Container.resolve — no silent undefined',
    );
  });

  // INVARIANT: two independent Containers each get their OWN controller instance
  // bound to the same Contract — no shared mutable state leaks between scopes.
  test('two Containers each resolve their own implementation of the same contract', async () => {
    const impl = (greeting: string) =>
      createController.implements(Greeter).create({
        inject: {},
        methods: () => ({ hello: async ({ body }) => ({ message: `${greeting} ${body.name}` }) }),
      });

    const A = impl('hoi');
    const B = impl('hello');

    const cA = new Container().register(A);
    const cB = new Container().register(B);

    const iA = await cA.resolve(A);
    const iB = await cB.resolve(B);

    assert.notEqual(iA, iB, 'distinct instances');

    const rA = await iA.methods.get('hello')!.handler({
      body: { name: 'x' }, metadata: new Map(), signal: new AbortController().signal, session: {},
    });
    const rB = await iB.methods.get('hello')!.handler({
      body: { name: 'x' }, metadata: new Map(), signal: new AbortController().signal, session: {},
    });
    assert.deepEqual(rA, { message: 'hoi x' });
    assert.deepEqual(rB, { message: 'hello x' });
  });

  // INVARIANT: the contract's methods Map has exactly the method names declared.
  // A rename or drop in the contract must surface as a missing-method error, not
  // as "handler silently never called".
  test('implementation of unknown method is ignored; missing method throws at resolve time', async () => {
    // Extra method in impl — today's behaviour is silently accepted. Pin it so
    // a future change is a deliberate decision.
    const Extra = createController.implements(Greeter).create({
      inject: {},
      methods: () => ({
        hello: async ({ body }) => ({ message: `hi ${body.name}` }),
        nonexistent: async () => ({ message: 'never called' }),
      }),
    });
    const c = new Container().register(Extra);
    const inst = await c.resolve(Extra);
    assert.equal(inst.methods.size, 1, 'only contract-declared methods are compiled');
    assert.ok(!inst.methods.has('nonexistent'));

    // Missing required method — resolving throws.
    const Missing = createController.implements(Greeter).create({
      inject: {},
      methods: () => ({} as any),
    });
    const c2 = new Container().register(Missing);
    await assert.rejects(
      c2.resolve(Missing),
      /hello.*not implemented.*svc\.Greeter/,
    );
  });
});
