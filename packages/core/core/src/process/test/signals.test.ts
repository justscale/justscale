/**
 * defineSignals - path-based declarative signal group with DI.
 *
 * Tests the runtime buildSignal wiring: path → signalName, identity
 * extraction for path params, and the value-to-identifier coercion.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { defineSignals } from '../define-signals.js';
import { AbstractProcessExecutor } from '../../runtime/process/executor.js';
import { Container } from '../../core/index.js';
import { Reference } from '../../models/reference/reference.js';
import { ADAPTER_KEY } from '../../models/symbols.js';

const SIGNAL_BRAND = Symbol.for('@justscale/process/signal');

// ---------------------------------------------------------------------------
// Minimal fake executor that records emit() calls.
// ---------------------------------------------------------------------------
class RecordingExecutor {
  public emits: Array<{
    signal: string;
    identity: Record<string, string>;
    payload: unknown;
  }> = [];

  async emit(signal: string, identity: Record<string, string>, payload: unknown): Promise<void> {
    this.emits.push({ signal, identity, payload });
  }
}

function makeContainerWithExecutor(exec: RecordingExecutor): Container {
  const c = new Container();
  c.registerInstance(AbstractProcessExecutor, exec as unknown as AbstractProcessExecutor);
  return c;
}

describe('defineSignals - path → signal name derivation', () => {
  it('single-segment path becomes dot-less signalName', async () => {
    class Sigs extends defineSignals((s) => ({
      ping: s('/ping'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = await c.resolve(Sigs);
    await (sigs as any).ping();
    assert.equal(exec.emits[0].signal, 'ping');
  });

  it('multi-segment path uses dots', async () => {
    class Sigs extends defineSignals((s) => ({
      done: s('/payment/completed'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = await c.resolve(Sigs);
    await (sigs as any).done();
    assert.equal(exec.emits[0].signal, 'payment.completed');
  });

  it('path with single param becomes dotted with param name stripped of colon', async () => {
    class Sigs extends defineSignals((s) => ({
      confirmed: s('/order/:orderId/confirmed'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = await c.resolve(Sigs);
    await (sigs as any).confirmed({ orderId: 'ord-1' });
    assert.equal(exec.emits[0].signal, 'order.orderId.confirmed');
    assert.deepEqual(exec.emits[0].identity, { orderId: 'ord-1' });
  });

  it('path with multiple params extracts all identity keys', async () => {
    class Sigs extends defineSignals((s) => ({
      moved: s('/org/:orgId/user/:userId/moved'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = await c.resolve(Sigs);
    await (sigs as any).moved({ orgId: 'o1', userId: 'u1' });
    assert.deepEqual(exec.emits[0].identity, { orgId: 'o1', userId: 'u1' });
  });

  it('empty path produces a random anonymous name (stable per call, at least non-empty)', async () => {
    class Sigs extends defineSignals((s) => ({
      anon: s(''),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = await c.resolve(Sigs);
    await (sigs as any).anon();
    assert.match(exec.emits[0].signal, /^anonymous\.[a-z0-9]+$/);
  });

  it('path with repeated param name throws at resolve time', async () => {
    class Sigs extends defineSignals((s) => ({
      weird: s('/a/:id/b/:id/c'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    await assert.rejects(
      async () => c.resolve(Sigs),
      /duplicate param ':id'/,
    );
  });

  it('signalName is readable on the built signal (metadata)', async () => {
    class Sigs extends defineSignals((s) => ({
      go: s('/workflow/:id/go'),
    })) {}
    const c = makeContainerWithExecutor(new RecordingExecutor());
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    assert.equal(sigs.go.signalName, 'workflow.id.go');
    assert.equal(sigs.go.path, '/workflow/:id/go');
  });

  it('.types() returns a new builder but same signalName', async () => {
    class Sigs extends defineSignals((s) => ({
      evt: s('/x/:id').types({}),
    })) {}
    const c = makeContainerWithExecutor(new RecordingExecutor());
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    assert.equal(sigs.evt.signalName, 'x.id');
  });

  it('.data<T>() is a no-op at runtime (type-level only)', async () => {
    class Sigs extends defineSignals((s) => ({
      evt: s('/payment/:id/confirmed').data<{ reason: string }>(),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    await sigs.evt({ id: 'p1', reason: 'ok' });
    // Payload carries all args (including path param)
    assert.deepEqual(exec.emits[0].payload, { id: 'p1', reason: 'ok' });
  });

  it('signal brand symbol is set on the built signal', async () => {
    class Sigs extends defineSignals((s) => ({
      evt: s('/x'),
    })) {}
    const c = makeContainerWithExecutor(new RecordingExecutor());
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    assert.equal(sigs.evt[SIGNAL_BRAND], SIGNAL_BRAND);
  });
});

describe('defineSignals - identity coercion', () => {
  it('string value is passed through as-is', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/x/:id'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    await sigs.e({ id: 'raw-string' });
    assert.equal(exec.emits[0].identity.id, 'raw-string');
  });

  it('Reference value yields its .identifier', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/x/:id'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    await sigs.e({ id: new Reference('ref-42') });
    assert.equal(exec.emits[0].identity.id, 'ref-42');
  });

  it('object with ADAPTER_KEY symbol yields that key', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/x/:id'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    const fakeEntity = { [ADAPTER_KEY]: 'entity-7' };
    await sigs.e({ id: fakeEntity });
    assert.equal(exec.emits[0].identity.id, 'entity-7');
  });

  it('plain object with .id falls back to that id', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/x/:id'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    await sigs.e({ id: { id: 'plain-id' } });
    assert.equal(exec.emits[0].identity.id, 'plain-id');
  });

  it('object without id or ADAPTER_KEY throws a descriptive error', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/x/:id'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    await assert.rejects(
      async () => sigs.e({ id: { foo: 'bar' } }),
      /Cannot extract identifier/,
    );
  });

  it('missing path param throws explicit "missing required path param" error', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/x/:id'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    await assert.rejects(
      async () => sigs.e({}),
      /missing required path param/,
    );
  });

  it('null value throws (no silent "null" string coercion)', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/x/:id'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    await assert.rejects(
      async () => sigs.e({ id: null as unknown as string }),
      /identifier is null\/undefined/,
    );
  });
});

describe('defineSignals - payload shape', () => {
  it('payload contains all args (path params + data) as received', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/x/:id').data<{ reason: string; score: number }>(),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    await sigs.e({ id: 'a', reason: 'why', score: 9 });
    assert.deepEqual(exec.emits[0].payload, { id: 'a', reason: 'why', score: 9 });
  });

  it('payload is an empty object when no args given and path has no params', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/ping'),
    })) {}
    const exec = new RecordingExecutor();
    const c = makeContainerWithExecutor(exec);
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    await sigs.e();
    assert.deepEqual(exec.emits[0].payload, {});
  });
});

describe('defineSignals - awaiting outside a handler is blocked', () => {
  it('awaiting signal directly throws via thenable guard', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/x'),
    })) {}
    const c = makeContainerWithExecutor(new RecordingExecutor());
    c.register(Sigs);
    const sigs = (await c.resolve(Sigs)) as any;
    assert.throws(() => sigs.e.then(), /Cannot await signal/);
  });
});

describe('defineSignals - DI and independence', () => {
  it('each container resolution gets an independent signal group', async () => {
    class Sigs extends defineSignals((s) => ({
      e: s('/x/:id'),
    })) {}

    const execA = new RecordingExecutor();
    const a = makeContainerWithExecutor(execA);
    a.register(Sigs);
    const sigsA = (await a.resolve(Sigs)) as any;

    const execB = new RecordingExecutor();
    const b = makeContainerWithExecutor(execB);
    b.register(Sigs);
    const sigsB = (await b.resolve(Sigs)) as any;

    await sigsA.e({ id: '1' });
    await sigsB.e({ id: '2' });

    assert.equal(execA.emits.length, 1);
    assert.equal(execB.emits.length, 1);
    assert.equal(execA.emits[0].identity.id, '1');
    assert.equal(execB.emits[0].identity.id, '2');
  });

  it('factory receives a callable signal factory', async () => {
    let sawFactory = false;
    class Sigs extends defineSignals((s) => {
      sawFactory = typeof s === 'function';
      return { e: s('/x') };
    }) {}
    const c = makeContainerWithExecutor(new RecordingExecutor());
    c.register(Sigs);
    await c.resolve(Sigs);
    assert.equal(sawFactory, true);
  });
});
