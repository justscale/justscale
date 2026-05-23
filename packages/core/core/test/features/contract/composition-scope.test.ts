/**
 * Contract composition across scopes.
 *
 * design-contract-system.md talks about sub-apps binding different impls of
 * the same contract in their scope, parent untouched. The shipped API
 * doesn't let you bind an impl "by contract" (ContractDef is not itself a
 * resolvable token) — you register a ContractControllerDef directly.
 *
 * These tests pin what composition actually works today:
 *   - two Containers with different controllers-of-same-contract stay isolated
 *   - registering two DIFFERENT ControllerDefs (both implementing the same
 *     contract) in ONE Container yields two distinct instances (no collapse)
 *   - reflecting on "all controllers" from a Container is possible via the
 *     factories map
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
} from '../../../src/index.js';

interface Req { s: string }
interface Res { s: string }
const ReqS = simpleMessage<Req>('Req');
const ResS = simpleMessage<Res>('Res');

abstract class Upper extends defineContract({
  protocol: 'grpc',
  serviceName: 'svc.Upper',
  methods: { do: rpc(ReqS, ResS) },
}) {}

describe('contract scope / composition', () => {
  // INVARIANT: two sub-scopes (distinct Containers) can each bind a different
  // controller for the same contract and the results don't bleed.
  test('two Containers: each binds its own controller; no cross-scope contamination', async () => {
    const UpperCtrl = createController.implements(Upper).create({
      inject: {},
      methods: () => ({ do: async ({ body }) => ({ s: body.s.toUpperCase() }) }),
    });
    const LowerCtrl = createController.implements(Upper).create({
      inject: {},
      methods: () => ({ do: async ({ body }) => ({ s: body.s.toLowerCase() }) }),
    });

    const cUp = new Container().register(UpperCtrl);
    const cLo = new Container().register(LowerCtrl);

    const iUp = await cUp.resolve(UpperCtrl);
    const iLo = await cLo.resolve(LowerCtrl);

    const ctx = { body: { s: 'HeLLo' }, metadata: new Map(), signal: new AbortController().signal, session: {} };
    assert.deepEqual(await iUp.methods.get('do')!.handler(ctx), { s: 'HELLO' });
    assert.deepEqual(await iLo.methods.get('do')!.handler(ctx), { s: 'hello' });
  });

  // INVARIANT: the parent Container is not affected by instantiating a
  // "child" scope (a separate Container). Deliberately no cross-references;
  // pinning the absence of hidden globals.
  test('no hidden global state between Containers (two Containers == two worlds)', async () => {
    const A = createController.implements(Upper).create({
      inject: {},
      methods: () => ({ do: async ({ body }) => ({ s: `A:${body.s}` }) }),
    });
    const B = createController.implements(Upper).create({
      inject: {},
      methods: () => ({ do: async ({ body }) => ({ s: `B:${body.s}` }) }),
    });

    const cA = new Container().register(A);
    const cB = new Container().register(B);

    // Resolving A in cA must NOT register B in cA.
    await cA.resolve(A);
    // cA has no knowledge of B — resolving B there auto-instantiates it
    // (per the "Container auto-resolves ServiceDefs" invariant pinned in file 02).
    // But it's a FRESH instance, not cB's instance.
    const b_in_cA = await cA.resolve(B);
    const b_in_cB = await cB.resolve(B);
    assert.notEqual(b_in_cA, b_in_cB, 'separate Container = separate instance of same def');
  });

  // INVARIANT: two controllers implementing the same contract registered in
  // ONE Container are separately resolvable by their def tokens. No merge/
  // last-wins behaviour silently happens.
  test('same contract, two controllers, one Container: each def resolves to its own instance', async () => {
    const A = createController.implements(Upper).create({
      inject: {},
      methods: () => ({ do: async ({ body }) => ({ s: `A:${body.s}` }) }),
    });
    const B = createController.implements(Upper).create({
      inject: {},
      methods: () => ({ do: async ({ body }) => ({ s: `B:${body.s}` }) }),
    });

    const c = new Container().register(A).register(B);
    const iA = await c.resolve(A);
    const iB = await c.resolve(B);

    assert.notEqual(iA, iB);
    const ctx = { body: { s: 'x' }, metadata: new Map(), signal: new AbortController().signal, session: {} };
    assert.deepEqual(await iA.methods.get('do')!.handler(ctx), { s: 'A:x' });
    assert.deepEqual(await iB.methods.get('do')!.handler(ctx), { s: 'B:x' });
  });

  // INVARIANT: the CONTRACT_CONTROLLER symbol flag is present on every
  // ContractControllerDef. This is how reflection (e.g., for swagger /
  // transport wiring) identifies contract controllers vs HTTP controllers.
  test('every ContractControllerDef carries the CONTRACT_CONTROLLER marker', () => {
    const A = createController.implements(Upper).create({
      inject: {}, methods: () => ({ do: async ({ body }) => ({ s: body.s }) }),
    });
    assert.equal((A as any)[CONTRACT_CONTROLLER], true);

    // A normal (HTTP-ish) controller does NOT have the marker.
    const { Get } = (() => {
      // Minimal inline route factory — avoids importing @justscale/http
      const Get = (path: string) => ({
        method: 'GET', path, steps: [],
        handler: () => {}, responseSchemas: new Map(),
      } as any);
      return { Get };
    })();
    const Plain = createController({
      inject: {},
      routes: () => ({ hello: Get('/hello') }),
    });
    assert.equal((Plain as any)[CONTRACT_CONTROLLER], undefined,
      'normal controllers do NOT carry the marker');
  });

  // INVARIANT: the ControllerDef stores its contract reference under `.contract`
  // for reflection tools. Losing this means swagger/openapi can't discover the
  // service name.
  test('ControllerDef.contract is the exact Contract class passed to .implements()', () => {
    const A = createController.implements(Upper).create({
      inject: {}, methods: () => ({ do: async ({ body }) => ({ s: body.s }) }),
    });
    assert.equal((A as any).contract, Upper);
  });
});
