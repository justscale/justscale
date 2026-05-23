/**
 * Error propagation across the contract boundary.
 *
 * For a distributed contract call, the caller MUST know whether the remote
 * side produced a typed error vs a generic failure. Silent error flattening
 * (e.g., every error becomes "Error: internal") defeats the whole point of
 * having typed RPC in the first place.
 *
 * These tests pin current behaviour of the in-memory proxy, which represents
 * what @justscale/rpc should aim for structurally.
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

function inMemoryProxy<C extends AnyContract>(
  local: ContractControllerInstance<C>,
  opts: { timeoutMs?: number } = {},
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

        let r: unknown;
        let err: unknown;
        try {
          const call = method.handler({
            body: decodeProcessable(parsed.body),
            metadata: ctx.metadata,
            signal: ctx.signal,
            session: ctx.session,
          });
          if (opts.timeoutMs !== undefined) {
            r = await Promise.race([
              call,
              new Promise((_res, rej) => setTimeout(() => rej(new Error('proxy timeout')), opts.timeoutMs!)),
            ]);
          } else {
            r = await call;
          }
        } catch (e) {
          err = e;
        }

        if (err !== undefined) {
          const src = err as Error;
          const rebuilt = new Error(src.message);
          rebuilt.name = src.name;
          if ((src as any).cause !== undefined) (rebuilt as any).cause = (src as any).cause;
          // Preserve extra structured fields (for typed errors).
          for (const k of Object.keys(src)) {
            (rebuilt as any)[k] = (src as any)[k];
          }
          throw rebuilt;
        }

        const back = JSON.stringify(encodeProcessable(r));
        return decodeProcessable(JSON.parse(back));
      },
    });
  }
  return proxy;
}

function ctx<T>(body: T) {
  return { body, metadata: new Map(), signal: new AbortController().signal, session: {} };
}

// Custom error type the handler might throw.
class NotFoundError extends Error {
  constructor(public resource: string, public id: string) {
    super(`${resource} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

describe('contract error propagation', () => {
  // INVARIANT: a plain Error thrown locally has the same message+name through
  // the proxy. Pin the minimum guarantee — if this drops we can never build
  // typed error handling on top.
  test('plain Error: message + name survive the proxy', async () => {
    const S = simpleMessage<{}>('S');
    const R = simpleMessage<{}>('R');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.E',
      methods: { fail: rpc(S, R) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {},
      methods: () => ({ fail: async () => { const e = new Error('boom'); e.name = 'MyErr'; throw e; } }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const grab = async (fn: () => unknown) => {
      try { await fn(); throw new Error('unreached'); } catch (e) { return e as Error; }
    };
    const eL = await grab(() => inst.methods.get('fail')!.handler(ctx({})));
    const eP = await grab(() => proxy.methods.get('fail')!.handler(ctx({})));

    assert.equal(eL.message, eP.message);
    assert.equal(eL.name, eP.name);
  });

  // INVARIANT: `.cause` chain survives. If cause is silently dropped, upstream
  // debugging during incidents becomes guesswork.
  test('Error .cause chain survives one level through the proxy', async () => {
    const S = simpleMessage<{}>('S');
    const R = simpleMessage<{}>('R');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Cause',
      methods: { fail: rpc(S, R) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {},
      methods: () => ({
        fail: async () => {
          const root = new Error('db timeout');
          root.name = 'DbTimeout';
          throw new Error('upstream', { cause: root });
        },
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const grab = async (fn: () => unknown) => {
      try { await fn(); throw new Error('unreached'); } catch (e) { return e as Error; }
    };
    const eP = await grab(() => proxy.methods.get('fail')!.handler(ctx({})));
    assert.equal(eP.message, 'upstream');
    const cause = (eP as any).cause as Error;
    assert.ok(cause instanceof Error);
    assert.equal(cause.name, 'DbTimeout');
    assert.equal(cause.message, 'db timeout');
  });

  // INVARIANT: custom error fields (on a subclass) reach the proxy. Pinning
  // the minimum — if this stops working, typed RPC errors (status codes,
  // resource names) can't be shipped at all.
  test('custom Error subclass: extra own-properties survive through the proxy', async () => {
    const S = simpleMessage<{}>('S');
    const R = simpleMessage<{}>('R');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Custom',
      methods: { fail: rpc(S, R) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {},
      methods: () => ({ fail: async () => { throw new NotFoundError('User', '42'); } }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    const grab = async (fn: () => unknown) => {
      try { await fn(); throw new Error('unreached'); } catch (e) { return e as Error; }
    };
    const eP = await grab(() => proxy.methods.get('fail')!.handler(ctx({}))) as NotFoundError;
    assert.equal(eP.name, 'NotFoundError');
    assert.equal(eP.message, 'User not found: 42');
    assert.equal((eP as any).resource, 'User');
    assert.equal((eP as any).id, '42');
    // NOTE: eP is NOT instanceof NotFoundError (class info is lost over the wire).
    // Callers must switch on .name, not instanceof — pin that too:
    assert.equal(eP instanceof NotFoundError, false,
      'class identity is NOT preserved across the proxy — callers must use .name');
  });

  // INVARIANT: proxy timeout produces a clearly identifiable error. Caller
  // must be able to distinguish timeout from remote-thrown error.
  test('proxy timeout: caller sees a timeout Error, not the eventual handler result', async () => {
    const S = simpleMessage<{}>('S');
    const R = simpleMessage<{ ok: boolean }>('R');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Slow',
      methods: { slow: rpc(S, R) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {},
      methods: () => ({
        slow: async () => {
          await new Promise(r => setTimeout(r, 50));
          return { ok: true };
        },
      }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst, { timeoutMs: 10 });

    await assert.rejects(
      async () => proxy.methods.get('slow')!.handler(ctx({})),
      /proxy timeout/,
    );
  });

  // INVARIANT: rejection of `undefined` (i.e., `throw undefined`) is
  // re-surfaced. Silent conversion to "success" would be catastrophic.
  test('throwing undefined: proxy still rejects (does not silently succeed)', async () => {
    const S = simpleMessage<{}>('S');
    const R = simpleMessage<{}>('R');
    abstract class Svc extends defineContract({
      protocol: 'grpc', serviceName: 'svc.Undef',
      methods: { weird: rpc(S, R) },
    }) {}
    const Ctrl = createController.implements(Svc).create({
      inject: {},
      methods: () => ({ weird: async () => { throw undefined; } }),
    });
    const inst = await new Container().register(Ctrl).resolve(Ctrl);
    const proxy = inMemoryProxy(inst);

    await assert.rejects(
      async () => proxy.methods.get('weird')!.handler(ctx({})),
    );
  });
});
