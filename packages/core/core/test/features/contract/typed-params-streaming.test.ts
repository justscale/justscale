/**
 * Typed inputs/outputs and streaming across the contract boundary.
 *
 * Contracts are RPC, not HTTP — "path params" from design-contract-system.md
 * don't apply to the shipped `createController.implements()` flow. Instead,
 * the boundary contract is:
 *   - streaming mode of each method is preserved exactly in the compiled method
 *   - the input/output MessageSchema identity is preserved (same object refs)
 *   - handlers for streaming methods receive the right body shape
 *     (AsyncIterable for client/bidi, plain value for unary/server)
 *
 * A silent mis-wiring here would cause a server-streaming method to be
 * treated as unary at the transport, dropping every yielded value after the
 * first.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineContract,
  rpc,
  simpleMessage,
  Container,
  createController,
} from '../../../src/index.js';

interface Q { q: string }
interface R { r: string }
const QS = simpleMessage<Q>('Q');
const RS = simpleMessage<R>('R');

abstract class Mixed extends defineContract({
  protocol: 'grpc',
  serviceName: 'svc.Mixed',
  methods: {
    unary: rpc(QS, RS),
    serverStream: rpc(QS, RS).serverStream(),
    clientStream: rpc(QS, RS).clientStream(),
    bidiStream: rpc(QS, RS).bidiStream(),
  },
}) {}

describe('typed input/output and streaming mode fidelity', () => {
  // INVARIANT: every method's streaming mode survives contract -> compiled method.
  // If a bidi gets downgraded to unary here, the transport will send one frame
  // and hang — a classic "silent success" regression.
  test('each method preserves its exact streaming mode', async () => {
    const Ctrl = createController.implements(Mixed).create({
      inject: {},
      methods: () => ({
        unary: async ({ body }) => ({ r: body.q }),
        serverStream: async function* ({ body }) { yield { r: body.q }; },
        clientStream: async () => ({ r: 'sum' }),
        bidiStream: async function* ({ body }) {
          for await (const m of body as AsyncIterable<Q>) yield { r: m.q };
        },
      }),
    });
    const c = new Container().register(Ctrl);
    const inst = await c.resolve(Ctrl);

    assert.equal(inst.methods.get('unary')!.streaming, 'unary');
    assert.equal(inst.methods.get('serverStream')!.streaming, 'server');
    assert.equal(inst.methods.get('clientStream')!.streaming, 'client');
    assert.equal(inst.methods.get('bidiStream')!.streaming, 'bidi');
  });

  // INVARIANT: the inputSchema/outputSchema references on the compiled method
  // are the SAME object identities as declared on the contract. The reflection
  // layer relies on identity to look up Processable descriptors.
  test('inputSchema and outputSchema are the exact MessageSchema objects from the contract', async () => {
    const Ctrl = createController.implements(Mixed).create({
      inject: {},
      methods: () => ({
        unary: async ({ body }) => ({ r: body.q }),
        serverStream: async function* ({ body }) { yield { r: body.q }; },
        clientStream: async () => ({ r: 'sum' }),
        bidiStream: async function* () { /* empty */ },
      }),
    });
    const c = new Container().register(Ctrl);
    const inst = await c.resolve(Ctrl);

    for (const name of ['unary', 'serverStream', 'clientStream', 'bidiStream'] as const) {
      const m = inst.methods.get(name)!;
      assert.equal(m.inputSchema, QS, `${name}.inputSchema is the shared QS reference`);
      assert.equal(m.outputSchema, RS, `${name}.outputSchema is the shared RS reference`);
    }
  });

  // INVARIANT: server-streaming handler yields all items; caller iterates.
  // Silent truncation (e.g., single-shot await) would break pagination RPCs.
  test('server-streaming handler yields every value the generator produces', async () => {
    const Ctrl = createController.implements(Mixed).create({
      inject: {},
      methods: () => ({
        unary: async ({ body }) => ({ r: body.q }),
        serverStream: async function* ({ body }) {
          for (const letter of body.q) yield { r: letter };
        },
        clientStream: async () => ({ r: 'sum' }),
        bidiStream: async function* () { /* empty */ },
      }),
    });
    const c = new Container().register(Ctrl);
    const inst = await c.resolve(Ctrl);

    const gen = inst.methods.get('serverStream')!.handler({
      body: { q: 'abc' },
      metadata: new Map(),
      signal: new AbortController().signal,
      session: {},
    }) as AsyncGenerator<R>;

    const results: R[] = [];
    for await (const v of gen) results.push(v);
    assert.deepEqual(results, [{ r: 'a' }, { r: 'b' }, { r: 'c' }]);
  });

  // INVARIANT: client-streaming handler receives body as AsyncIterable and
  // produces a single value. A transport that forgets the iteration would
  // observe only the first input — pin the contract here.
  test('client-streaming handler sees body as AsyncIterable and returns a single value', async () => {
    const Ctrl = createController.implements(Mixed).create({
      inject: {},
      methods: () => ({
        unary: async ({ body }) => ({ r: body.q }),
        serverStream: async function* () { /* empty */ },
        clientStream: async ({ body }) => {
          const parts: string[] = [];
          for await (const m of body as AsyncIterable<Q>) parts.push(m.q);
          return { r: parts.join(',') };
        },
        bidiStream: async function* () { /* empty */ },
      }),
    });
    const c = new Container().register(Ctrl);
    const inst = await c.resolve(Ctrl);

    async function* send(): AsyncGenerator<Q> {
      yield { q: 'a' }; yield { q: 'b' }; yield { q: 'c' };
    }

    const result = await inst.methods.get('clientStream')!.handler({
      body: send(),
      metadata: new Map(),
      signal: new AbortController().signal,
      session: {},
    });
    assert.deepEqual(result, { r: 'a,b,c' });
  });

  // INVARIANT: bidi handler sees AsyncIterable in AND yields AsyncIterable out,
  // correlating 1:1 if the handler chooses. Breaking this (e.g., consuming the
  // input before yielding) would deadlock the transport.
  test('bidi handler correlates input and output one-for-one', async () => {
    const Ctrl = createController.implements(Mixed).create({
      inject: {},
      methods: () => ({
        unary: async ({ body }) => ({ r: body.q }),
        serverStream: async function* () { /* empty */ },
        clientStream: async () => ({ r: '' }),
        bidiStream: async function* ({ body }) {
          for await (const m of body as AsyncIterable<Q>) {
            yield { r: `echo:${m.q}` };
          }
        },
      }),
    });
    const c = new Container().register(Ctrl);
    const inst = await c.resolve(Ctrl);

    async function* send(): AsyncGenerator<Q> {
      yield { q: 'one' }; yield { q: 'two' };
    }
    const gen = inst.methods.get('bidiStream')!.handler({
      body: send(),
      metadata: new Map(),
      signal: new AbortController().signal,
      session: {},
    }) as AsyncGenerator<R>;

    const results: R[] = [];
    for await (const v of gen) results.push(v);
    assert.deepEqual(results, [{ r: 'echo:one' }, { r: 'echo:two' }]);
  });
});
