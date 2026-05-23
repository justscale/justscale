/**
 * The core claim: calling a contract method LOCALLY vs THROUGH A PROXY must
 * be observationally identical for legal inputs.
 *
 * design-contract-system.md:
 *   > "when bound as a proxy [a contract] appears identical to local"
 *
 * The real remote transport lives in @justscale/rpc (out of scope). We build
 * an InMemory proxy here and run each assertion twice — once against the
 * local impl, once through the proxy — asserting both return / throw the
 * same thing. The diff is "the boundary cost", which must be zero for
 * legal inputs.
 *
 * The proxy:
 *   - serialises args via Processable (encodeProcessable / decodeProcessable)
 *   - dispatches over a Map-backed channel (still same process, but crossing
 *     a JSON boundary in between, like a real wire)
 *   - hydrates the response on the caller side
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineContract,
  rpc,
  simpleMessage,
  Container,
  createController,
  type ContractControllerInstance,
  type AnyContract,
  type ContractMetadata,
  CONTRACT_METADATA,
} from '../../../src/index.js';
import {
  encodeProcessable,
  decodeProcessable,
} from '../../../src/process/serialization.js';

// ============================================================================
// InMemory proxy — simulates a network-separated impl
// ============================================================================

/**
 * Take a local ContractControllerInstance and return a callable proxy that
 * has the same shape. Every call round-trips through JSON + Processable.
 */
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
        // ===== wire encode =====
        const wire = JSON.stringify({
          body: encodeProcessable(ctx.body),
          metadata: [...(ctx.metadata as Map<string, string>)],
        });

        // ===== remote side: decode, call local, encode response =====
        const parsed = JSON.parse(wire);
        let remoteResult: unknown;
        let remoteError: unknown;
        try {
          remoteResult = await method.handler({
            body: decodeProcessable(parsed.body),
            metadata: new Map(parsed.metadata as [string, string][]),
            signal: ctx.signal,  // signals don't serialise; pass through
            session: ctx.session,
          });
        } catch (err) {
          remoteError = err;
        }

        // ===== caller side: decode =====
        if (remoteError !== undefined) {
          // Preserve structural equivalence: name + message + cause chain.
          const src = remoteError as Error;
          const rebuilt = new Error(src.message);
          rebuilt.name = src.name;
          if ((src as any).cause !== undefined) (rebuilt as any).cause = (src as any).cause;
          throw rebuilt;
        }

        if (method.streaming === 'server' || method.streaming === 'bidi') {
          // Iterate the remote generator, shuttle yielded values
          const gen = remoteResult as AsyncIterable<unknown>;
          return (async function* () {
            for await (const v of gen) {
              const w = JSON.stringify(encodeProcessable(v));
              yield decodeProcessable(JSON.parse(w));
            }
          })();
        }

        const returnedWire = JSON.stringify(encodeProcessable(remoteResult));
        return decodeProcessable(JSON.parse(returnedWire));
      },
    });
  }

  return proxy;
}

// ============================================================================
// Test contract
// ============================================================================

interface Req { a: number; b: number }
interface Res { sum: number }
const ReqS = simpleMessage<Req>('Req');
const ResS = simpleMessage<Res>('Res');

interface Item { v: string }
const ItemS = simpleMessage<Item>('Item');

abstract class Svc extends defineContract({
  protocol: 'grpc',
  serviceName: 'svc.ProxyTest',
  methods: {
    add: rpc(ReqS, ResS),
    enumerate: rpc(ReqS, ItemS).serverStream(),
    explode: rpc(ReqS, ResS),
  },
}) {}

async function makeBoth(): Promise<[
  ContractControllerInstance<typeof Svc>,
  ContractControllerInstance<typeof Svc>,
]> {
  const Ctrl = createController.implements(Svc).create({
    inject: {},
    methods: () => ({
      add: async ({ body }) => ({ sum: body.a + body.b }),
      enumerate: async function* ({ body }) {
        for (let i = body.a; i < body.b; i++) yield { v: `x${i}` };
      },
      explode: async () => {
        const inner = new Error('root cause');
        inner.name = 'RootCauseError';
        throw Object.assign(new Error('boom'), { name: 'BoomError', cause: inner });
      },
    }),
  });
  const c = new Container().register(Ctrl);
  const local = await c.resolve(Ctrl);
  const proxy = inMemoryProxy(local);
  return [local, proxy];
}

function ctx<T>(body: T) {
  return {
    body,
    metadata: new Map<string, string>(),
    signal: new AbortController().signal,
    session: {},
  };
}

describe('contract proxy vs local — observational identity', () => {
  // INVARIANT: for legal primitive inputs, unary call returns the same value
  // shape + contents in both local and proxy modes.
  test('unary: local result === proxy result (deepEqual)', async () => {
    const [local, proxy] = await makeBoth();
    const local_r = await local.methods.get('add')!.handler(ctx<Req>({ a: 7, b: 8 }));
    const proxy_r = await proxy.methods.get('add')!.handler(ctx<Req>({ a: 7, b: 8 }));
    assert.deepEqual(local_r, { sum: 15 });
    assert.deepEqual(proxy_r, local_r, 'proxy returns the same structure');
  });

  // INVARIANT: server-streaming yields identical sequences locally and via proxy.
  // Mis-wired yield/return semantics would cause the proxy to drop trailing items.
  test('server-streaming: both sides iterate to the same sequence', async () => {
    const [local, proxy] = await makeBoth();
    const drain = async <T>(gen: AsyncGenerator<T>) => {
      const out: T[] = [];
      for await (const v of gen) out.push(v);
      return out;
    };
    const localItems = await drain(local.methods.get('enumerate')!.handler(ctx<Req>({ a: 1, b: 4 })) as AsyncGenerator<Item>);
    const proxyItems = await drain(await (proxy.methods.get('enumerate')!.handler(ctx<Req>({ a: 1, b: 4 })) as any) as AsyncGenerator<Item>);
    assert.deepEqual(localItems, [{ v: 'x1' }, { v: 'x2' }, { v: 'x3' }]);
    assert.deepEqual(proxyItems, localItems);
  });

  // INVARIANT: a thrown error locally surfaces a structurally-equivalent error
  // through the proxy (same name + message + cause). A silent error-swallow
  // here is exactly the class of bug the test mandates pinning.
  test('error: local throw and proxy throw carry matching name / message / cause', async () => {
    const [local, proxy] = await makeBoth();
    const catchIt = async (fn: () => unknown) => {
      try { await fn(); throw new Error('unreached'); } catch (e) { return e as Error; }
    };

    const eLocal = await catchIt(() => local.methods.get('explode')!.handler(ctx<Req>({ a: 0, b: 0 })));
    const eProxy = await catchIt(() => proxy.methods.get('explode')!.handler(ctx<Req>({ a: 0, b: 0 })));

    assert.equal(eLocal.name, 'BoomError');
    assert.equal(eProxy.name, 'BoomError', 'proxy error name preserved');
    assert.equal(eLocal.message, eProxy.message, 'message preserved');
    assert.ok((eLocal as any).cause instanceof Error, 'local has cause');
    assert.ok((eProxy as any).cause instanceof Error, 'proxy has cause');
    assert.equal((eLocal as any).cause.message, (eProxy as any).cause.message);
  });

  // INVARIANT: A Date nested inside a plain object round-trips as a Date through
  // the proxy. encodeProcessable walks into plain objects recursively, so nested
  // Processable values (Date, Map, Reference, etc.) are encoded and restored
  // correctly. Local and proxy observation are identical.
  test('nested Date round-trips as Date through the proxy (ctr-1)', async () => {
    interface DateReq { when: Date }
    interface DateRes { echoed: Date }
    const DReqS = simpleMessage<DateReq>('DateReq');
    const DResS = simpleMessage<DateRes>('DateRes');
    abstract class DateSvc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Date',
      methods: {
        echoNested: rpc(DReqS, DResS),
      },
    }) {}

    const Ctrl = createController.implements(DateSvc).create({
      inject: {},
      methods: () => ({
        echoNested: async ({ body }) => ({ echoed: body.when }),
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const now = new Date('2024-01-15T12:34:56.000Z');

    const local_r = await inst.methods.get('echoNested')!.handler(ctx<DateReq>({ when: now })) as DateRes;
    const proxy_r = await proxy.methods.get('echoNested')!.handler(ctx<DateReq>({ when: now })) as DateRes;

    // LOCAL: Date survives as the same reference.
    assert.ok(local_r.echoed instanceof Date);
    assert.equal(local_r.echoed.getTime(), now.getTime());

    // PROXY: encodeProcessable recurses into plain objects, so the nested Date
    // is encoded and decoded correctly — proxy observation matches local.
    assert.ok(proxy_r.echoed instanceof Date, 'nested Date survives as Date through proxy');
    assert.equal(proxy_r.echoed.getTime(), now.getTime(), 'timestamp preserved');
  });

  // INVARIANT: Date at the TOP LEVEL round-trips correctly because encodeProcessable
  // sees it directly. Pin the path that IS symmetric so we don't lose it.
  test('top-level Date (as the entire return value) round-trips as Date', async () => {
    const DateSchema = simpleMessage<Date>('TopLevelDate');
    const EmptyReq = simpleMessage<{}>('EmptyReq');
    abstract class TopSvc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.TopDate',
      methods: { now: rpc(EmptyReq, DateSchema) },
    }) {}
    const Ctrl = createController.implements(TopSvc).create({
      inject: {},
      methods: () => ({
        now: async () => new Date('2024-01-15T12:34:56.000Z') as any,
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const local_r = await inst.methods.get('now')!.handler(ctx({})) as Date;
    const proxy_r = await proxy.methods.get('now')!.handler(ctx({})) as Date;

    assert.ok(local_r instanceof Date);
    assert.ok(proxy_r instanceof Date, 'top-level Date stays a Date through the proxy');
    assert.equal(proxy_r.getTime(), local_r.getTime());
  });

  // INVARIANT: the metadata Map is observable on both sides. If the proxy
  // stripped metadata silently, auth headers would vanish over the wire.
  test('metadata Map traverses the proxy round trip', async () => {
    interface EmptyReq {}
    interface EchoRes { keys: string[]; value: string }
    const ER = simpleMessage<EmptyReq>('ER');
    const XR = simpleMessage<EchoRes>('XR');
    abstract class EchoSvc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Echo',
      methods: { echoMeta: rpc(ER, XR) },
    }) {}
    const Ctrl = createController.implements(EchoSvc).create({
      inject: {},
      methods: () => ({
        echoMeta: async ({ metadata }) => ({
          keys: [...metadata.keys()].sort(),
          value: metadata.get('x-user') ?? '',
        }),
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const mkCtx = () => ({
      body: {},
      metadata: new Map([['x-user', 'alice'], ['x-trace', 't1']]),
      signal: new AbortController().signal,
      session: {},
    });
    const local_r = await inst.methods.get('echoMeta')!.handler(mkCtx());
    const proxy_r = await proxy.methods.get('echoMeta')!.handler(mkCtx());
    assert.deepEqual(local_r, { keys: ['x-trace', 'x-user'], value: 'alice' });
    assert.deepEqual(proxy_r, local_r);
  });

  // INVARIANT: the proxy exposes the SAME contract + metadata identity as the
  // local impl. Code that reflects on `instance.contract` or `instance.metadata`
  // must not observe a difference.
  test('proxy preserves contract and metadata references', async () => {
    const [local, proxy] = await makeBoth();
    assert.equal(proxy.contract, local.contract);
    assert.equal(proxy.metadata, local.metadata);
    assert.equal((proxy.contract as any)[CONTRACT_METADATA], (local.contract as any)[CONTRACT_METADATA]);
  });
});
