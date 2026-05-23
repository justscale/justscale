/**
 * Reflection and metadata discovery for contract-based controllers.
 *
 * Transport layers (@justscale/rpc, openapi, reflection.v1alpha) and tools
 * (just CLI introspection) must be able to walk the Container and find all
 * contract controllers, enumerate their methods, and read their schemas.
 *
 * Today there is NO `AbstractContainer.controllers({ kind: 'http' })` API
 * on the public surface. Reflection goes through:
 *   - the CONTRACT_CONTROLLER symbol flag on ControllerDefs
 *   - reading `def.contract[CONTRACT_METADATA]`
 *   - iterating `instance.methods` after resolve
 *
 * These tests pin the properties reflection tools CAN rely on.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineContract,
  rpc,
  simpleMessage,
  Container,
  createController,
  CONTRACT_CONTROLLER,
  CONTRACT_METADATA,
  CONTRACT_ID,
  getContractMetadata,
  type AnyContract,
  type ContractMetadata,
} from '../../../src/index.js';

interface Req { q: string }
interface Res { a: string }
const ReqS = simpleMessage<Req>('Req');
const ResS = simpleMessage<Res>('Res');

abstract class UserSvc extends defineContract({
  protocol: 'grpc',
  serviceName: 'svc.Users',
  methods: {
    get: rpc(ReqS, ResS),
    list: rpc(ReqS, ResS).serverStream(),
  },
}) {}

abstract class OrderSvc extends defineContract({
  protocol: 'grpc',
  serviceName: 'svc.Orders',
  methods: {
    place: rpc(ReqS, ResS),
  },
}) {}

describe('contract reflection & metadata', () => {
  // INVARIANT: contract metadata contains protocol + serviceName + methods.
  // A reflection tool reads these to generate the Swagger / proto descriptor.
  test('contract metadata surfaces protocol, serviceName and method shapes', () => {
    const meta = getContractMetadata(UserSvc as any) as ContractMetadata;
    assert.equal(meta.protocol, 'grpc');
    assert.equal(meta.serviceName, 'svc.Users');
    assert.deepEqual(
      Object.keys(meta.methods).sort(),
      ['get', 'list'],
    );
    assert.equal(meta.methods.get.streaming, 'unary');
    assert.equal(meta.methods.list.streaming, 'server');
  });

  // INVARIANT: each method's MessageSchema carries $type='message' and $name.
  // That's the minimum shape a reflection layer needs to render method docs.
  test('MessageSchema on each method exposes $type, $name, create()', () => {
    const meta = getContractMetadata(UserSvc as any);
    const input = meta.methods.get.input;
    assert.equal(input.$type, 'message');
    assert.equal(typeof input.$name, 'string');
    assert.equal(typeof input.create, 'function');
  });

  // INVARIANT: a compiled ContractControllerInstance exposes:
  //   .contract  — the Contract class
  //   .metadata  — the metadata object
  //   .methods   — a Map<string, CompiledRpcMethod>
  // Reflection walks these at runtime.
  test('resolved instance has .contract, .metadata, .methods Map', async () => {
    const Ctrl = createController.implements(UserSvc).create({
      inject: {},
      methods: () => ({
        get: async ({ body }) => ({ a: body.q }),
        list: async function* ({ body }) { yield { a: body.q }; },
      }),
    });
    const c = new Container().register(Ctrl);
    const inst = await c.resolve(Ctrl);

    assert.equal(inst.contract, UserSvc);
    assert.equal(inst.metadata.serviceName, 'svc.Users');
    assert.ok(inst.methods instanceof Map);
    assert.equal(inst.methods.size, 2);
    for (const m of inst.methods.values()) {
      assert.equal(typeof m.name, 'string');
      assert.equal(typeof m.handler, 'function');
      assert.ok(['unary', 'server', 'client', 'bidi'].includes(m.streaming));
    }
  });

  // INVARIANT: CONTRACT_ID is stable PER CONTRACT across resolves. A reflection
  // registry keyed by CONTRACT_ID must not drift as the app runs.
  test('CONTRACT_ID is stable across multiple metadata lookups', async () => {
    const first = (UserSvc as any)[CONTRACT_ID];
    const second = (UserSvc as any)[CONTRACT_ID];
    assert.equal(first, second);

    const Ctrl = createController.implements(UserSvc).create({
      inject: {}, methods: () => ({
        get: async ({ body }) => ({ a: body.q }),
        list: async function* ({ body }) { yield { a: body.q }; },
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    assert.equal((inst.contract as any)[CONTRACT_ID], first);
  });

  // INVARIANT: reflection can walk many controllers and classify them by
  // whether they carry the CONTRACT_CONTROLLER marker. Mimics what a cluster
  // plugin would do at serve-time.
  test('mass classification: filter controllers-with-contract from a mixed list', () => {
    const Users = createController.implements(UserSvc).create({
      inject: {}, methods: () => ({
        get: async ({ body }) => ({ a: body.q }),
        list: async function* ({ body }) { yield { a: body.q }; },
      }),
    });
    const Orders = createController.implements(OrderSvc).create({
      inject: {}, methods: () => ({ place: async ({ body }) => ({ a: body.q }) }),
    });
    // A plain (non-contract) controller.
    const PlainCtrl = createController({
      inject: {},
      routes: () => ({}),
    });

    const all = [Users, Orders, PlainCtrl];
    const contracts = all.filter(d => (d as any)[CONTRACT_CONTROLLER] === true);
    assert.equal(contracts.length, 2);

    const services = contracts.map(d => getContractMetadata((d as any).contract as AnyContract).serviceName);
    assert.deepEqual(services.sort(), ['svc.Orders', 'svc.Users']);
  });

  // INVARIANT: each CompiledRpcMethod's streaming tag matches what the contract
  // declared — reflection relies on this to produce correct proto descriptors.
  test('streaming tag on compiled method matches contract declaration for all modes', async () => {
    abstract class Mixed extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Mixed',
      methods: {
        a: rpc(ReqS, ResS),
        b: rpc(ReqS, ResS).serverStream(),
        c: rpc(ReqS, ResS).clientStream(),
        d: rpc(ReqS, ResS).bidiStream(),
      },
    }) {}
    const Ctrl = createController.implements(Mixed).create({
      inject: {},
      methods: () => ({
        a: async ({ body }) => ({ a: body.q }),
        b: async function* ({ body }) { yield { a: body.q }; },
        c: async () => ({ a: '' }),
        d: async function* () { /* empty */ },
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const modes = [...inst.methods.values()].map(m => [m.name, m.streaming]);
    const expected = [['a', 'unary'], ['b', 'server'], ['c', 'client'], ['d', 'bidi']];
    assert.deepEqual(modes.sort(), expected.sort());
  });
});
