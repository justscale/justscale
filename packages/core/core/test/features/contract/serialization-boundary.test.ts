/**
 * Serialisation boundary for contract calls.
 *
 * These tests pin *which categories of values* survive the current
 * Processable-based wire encoding used by the in-memory proxy, and WHICH
 * degrade. The distinction matters — design-contract-system.md promises
 * "observationally identical"; when the wire lossy-converts a value, the
 * proxy diverges from local.
 *
 * Categories covered:
 *   - primitives (number, string, boolean, null)
 *   - undefined vs missing keys
 *   - Map / Set at top level (Processable)
 *   - Reference (Processable)
 *   - BigInt (JSON.stringify rejects it)
 *   - arrays of primitives
 *   - circular object: must not hang
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineContract,
  rpc,
  simpleMessage,
  Container,
  createController,
  type AnyContract,
  type ContractControllerInstance,
} from '../../../src/index.js';
import {
  encodeProcessable,
  decodeProcessable,
} from '../../../src/process/serialization.js';
import { Reference } from '../../../src/models/reference/reference.js';

function inMemoryProxy<C extends AnyContract>(
  local: ContractControllerInstance<C>,
): ContractControllerInstance<C> {
  const proxy: ContractControllerInstance<C> = {
    contract: local.contract,
    metadata: local.metadata,
    deps: local.deps,
    methods: new Map(),
  };
  for (const [name, method] of local.methods) {
    proxy.methods.set(name, {
      ...method,
      handler: async (ctx: any) => {
        const wire = JSON.stringify({ body: encodeProcessable(ctx.body) });
        const parsed = JSON.parse(wire);
        const remote = await method.handler({
          body: decodeProcessable(parsed.body),
          metadata: ctx.metadata,
          signal: ctx.signal,
          session: ctx.session,
        });
        const back = JSON.stringify(encodeProcessable(remote));
        return decodeProcessable(JSON.parse(back));
      },
    });
  }
  return proxy;
}

function ctx<T>(body: T) {
  return { body, metadata: new Map(), signal: new AbortController().signal, session: {} };
}

describe('contract serialisation boundary', () => {
  // INVARIANT: primitives + null + plain nested objects survive byte-for-byte.
  test('primitives + null + plain nested objects are preserved', async () => {
    interface In { s: string; n: number; b: boolean; nil: null; nested: { x: number } }
    const S = simpleMessage<In>('S');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Prim',
      methods: { echo: rpc(S, S) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {}, methods: () => ({ echo: async ({ body }) => body }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const input: In = { s: 'hi', n: 42, b: true, nil: null, nested: { x: 7 } };
    const local_r = await inst.methods.get('echo')!.handler(ctx(input));
    const proxy_r = await proxy.methods.get('echo')!.handler(ctx(input));
    assert.deepEqual(local_r, input);
    assert.deepEqual(proxy_r, input, 'proxy result structurally equal to local');
  });

  // INVARIANT: `undefined` vs missing-key distinction is LOST on the wire
  // (JSON has no `undefined`). Pin this so callers know not to rely on it.
  test('undefined values in the return value are dropped across the proxy', async () => {
    interface In { x: number }
    interface Out { a: number; b: number | undefined }
    const S = simpleMessage<In>('S');
    const O = simpleMessage<Out>('O');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Undef',
      methods: { ret: rpc(S, O) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {}, methods: () => ({ ret: async () => ({ a: 1, b: undefined }) }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const local_r = await inst.methods.get('ret')!.handler(ctx<In>({ x: 0 })) as Out;
    const proxy_r = await proxy.methods.get('ret')!.handler(ctx<In>({ x: 0 })) as Record<string, unknown>;
    assert.equal('b' in local_r, true, 'local keeps the key even with undefined');
    assert.equal('b' in proxy_r, false, 'proxy drops the key (JSON behaviour)');
    assert.equal(proxy_r.a, 1);
  });

  // INVARIANT: top-level Map and Set are Processable and survive.
  test('top-level Map and Set round-trip', async () => {
    const MapSchema = simpleMessage<Map<string, number>>('M');
    const SetSchema = simpleMessage<Set<string>>('Se');
    const EmptyReq = simpleMessage<{}>('Empty');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.MS',
      methods: {
        m: rpc(EmptyReq, MapSchema),
        s: rpc(EmptyReq, SetSchema),
      },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {},
      methods: () => ({
        m: async () => new Map([['a', 1], ['b', 2]]) as any,
        s: async () => new Set(['x', 'y']) as any,
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const m_local = await inst.methods.get('m')!.handler(ctx({})) as Map<string, number>;
    const m_proxy = await proxy.methods.get('m')!.handler(ctx({})) as Map<string, number>;
    assert.ok(m_proxy instanceof Map, 'proxy returns a Map (not a plain obj)');
    assert.equal(m_proxy.get('a'), 1);
    assert.equal(m_proxy.size, m_local.size);

    const s_local = await inst.methods.get('s')!.handler(ctx({})) as Set<string>;
    const s_proxy = await proxy.methods.get('s')!.handler(ctx({})) as Set<string>;
    assert.ok(s_proxy instanceof Set);
    assert.equal(s_proxy.has('x'), true);
    assert.equal(s_proxy.size, s_local.size);
  });

  // INVARIANT (DIVERGENCE PINNED): Reference at the top level cannot be returned
  // from async contract handlers because Reference is PromiseLike — the async
  // runtime calls its `.then()`, which tries to resolve it and THROWS if no
  // resolver is attached. This is a fundamental tension between the async
  // handler contract and the Reference type.
  //
  // The wire protocol itself (encodeProcessable/decodeProcessable) DOES preserve
  // a Reference — we verify that directly — but returning one via async handler
  // fails before it ever reaches the wire. Pin both sides so a change to either
  // is intentional.
  test('Reference survives raw encodeProcessable/decodeProcessable (direct test)', () => {
    const ref = new Reference('user-42');
    const encoded = encodeProcessable(ref);
    const wire = JSON.parse(JSON.stringify(encoded));
    const decoded = decodeProcessable(wire) as Reference<unknown>;
    assert.ok(decoded instanceof Reference, 'round-trip yields a Reference');
    assert.equal(decoded.identifier, 'user-42');
  });

  // INVARIANT: attempting to RETURN a Reference from an async handler hits
  // Reference's own PromiseLike-resolve path and throws — not the proxy boundary
  // losing the Reference silently. Pin the throw so callers know the shape.
  test('returning a Reference from an async handler throws via Reference.then (not silent)', async () => {
    const RefSchema = simpleMessage<Reference<unknown>>('RefOut');
    const Empty = simpleMessage<{}>('E');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.RefAsync',
      methods: { make: rpc(Empty, RefSchema) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {},
      methods: () => ({ make: (async () => new Reference('u-1')) as any }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);

    // Calling the local handler already blows up — the boundary doesn't even
    // get a chance. Loud failure = good.
    await assert.rejects(
      async () => inst.methods.get('make')!.handler(ctx({})),
      /Reference has no resolver/,
    );
  });

  // INVARIANT: a Reference nested inside a plain object IS preserved across the
  // proxy boundary. encodeProcessable recurses into plain objects and encodes
  // nested Processable values (including Reference), so the receiver gets a
  // proper Reference back. Local and proxy observation are identical (ctr-2).
  test('Reference nested in object: round-trips as Reference through proxy (ctr-2)', async () => {
    const Res = simpleMessage<{ ref: Reference<unknown> }>('ResNested');
    const Empty = simpleMessage<{}>('E');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.RefNest',
      methods: { wrap: rpc(Empty, Res) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {},
      methods: () => ({
        wrap: (async () => ({ ref: new Reference('u-1') })) as any,
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const proxy_r = await proxy.methods.get('wrap')!.handler(ctx({})) as any;
    // encodeProcessable recurses — nested Reference IS rehydrated correctly.
    assert.ok(proxy_r.ref instanceof Reference, 'nested Reference is a Reference after proxy round-trip');
    assert.equal(proxy_r.ref.identifier, 'u-1', 'identifier preserved');
  });

  // INVARIANT: passing a Reference AS INPUT is symmetric — server receives a
  // Reference with the same identifier.
  test('Reference as method input round-trips', async () => {
    const RefIn = simpleMessage<Reference<unknown>>('RIn');
    const StrOut = simpleMessage<{ id: string }>('SOut');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.RefIn',
      methods: { observe: rpc(RefIn, StrOut) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {},
      methods: () => ({
        observe: async ({ body }) => {
          if (!(body instanceof Reference)) {
            return { id: `NOT-A-REFERENCE:${typeof body}` };
          }
          return { id: body.identifier };
        },
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const ref = new Reference('order-99');
    const local_r = await inst.methods.get('observe')!.handler(ctx(ref as any));
    const proxy_r = await proxy.methods.get('observe')!.handler(ctx(ref as any));
    assert.deepEqual(local_r, { id: 'order-99' });
    assert.deepEqual(proxy_r, local_r);
  });

  // INVARIANT: BigInt is rejected loudly by JSON.stringify. Pin that the
  // failure mode is a throw, not a silent coercion (e.g., "[object]").
  test('BigInt in a response throws at the wire boundary, not silently mangled', async () => {
    const In = simpleMessage<{ n: number }>('In');
    const Out = simpleMessage<{ v: bigint }>('Out');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.BI',
      methods: { ret: rpc(In, Out) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {}, methods: () => ({ ret: async () => ({ v: 42n }) }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    // LOCAL: returns the bigint directly, no wire, so no error.
    const local_r = await inst.methods.get('ret')!.handler(ctx({ n: 0 }));
    assert.equal((local_r as any).v, 42n);

    // PROXY: JSON.stringify on a bigint throws TypeError. Loud failure = good.
    await assert.rejects(
      async () => proxy.methods.get('ret')!.handler(ctx({ n: 0 })),
      /BigInt/i,
    );
  });

  // INVARIANT: arrays of primitives survive.
  test('arrays of primitives preserved exactly', async () => {
    const S = simpleMessage<{ xs: number[] }>('S');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Arr',
      methods: { echo: rpc(S, S) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {}, methods: () => ({ echo: async ({ body }) => body }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const input = { xs: [1, 2, 3, 4, 5] };
    const proxy_r = await proxy.methods.get('echo')!.handler(ctx(input));
    assert.deepEqual(proxy_r, input);
  });

  // INVARIANT: circular references are rejected loudly (JSON.stringify throws).
  // The boundary MUST NOT hang, loop forever, or silently truncate.
  test('circular reference in the response rejects cleanly — does not hang', async () => {
    const S = simpleMessage<any>('Any');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Cir',
      methods: { circ: rpc(S, S) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {},
      methods: () => ({
        circ: async () => {
          const obj: any = { a: 1 };
          obj.self = obj;
          return obj;
        },
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    // Local always works — no wire.
    const local_r = await inst.methods.get('circ')!.handler(ctx({}));
    assert.equal((local_r as any).self, local_r);

    // Proxy throws because encodeProcessable detects the cycle before JSON.stringify.
    await assert.rejects(
      async () => proxy.methods.get('circ')!.handler(ctx({})),
      /circular|converting|cyclic|call stack|cycle at/i,
    );
  });
});
