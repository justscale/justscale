/**
 * createProcess - definition shape, compiler markers, ServiceDef surface.
 *
 * The process callable is a runtime stub that throws until the compiler
 * transforms it. What we CAN test without the compiler: the metadata
 * attached to the definition (path, config, injection deps, SUBPROCESS /
 * PROCESS_DEFINITION markers, factory shape).
 *
 * Additionally we test the helpers that live in the runtime executor
 * module: generateInstanceId, resolvePath, extractIdentity.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createProcess, createSubProcess, SUBPROCESS_DEFINITION } from '../createProcess.js';
import {
  generateInstanceId,
  resolvePath,
  extractIdentity,
} from '../../runtime/process/executor.js';

const PROCESS_DEFINITION = Symbol.for('justscale:processDefinition');

describe('createProcess - definition shape', () => {
  it('stores path exactly as given', () => {
    const P = createProcess({
      path: '/order/:id/fulfillment',
      inject: {},
      async handler() {
        return { ok: true };
      },
    });
    assert.equal(P.path, '/order/:id/fulfillment');
  });

  it('exposes PROCESS_DEFINITION marker symbol', () => {
    const P = createProcess({
      path: '/x',
      inject: {},
      async handler() {
        return 1;
      },
    });
    assert.equal((P as any)[PROCESS_DEFINITION], true);
  });

  it('definition is callable (though throws until compiled)', async () => {
    const P = createProcess({
      path: '/x/:id',
      inject: {},
      async handler() {
        return 1;
      },
    });
    await assert.rejects(
      async () => P(['1']),
      /not compiled/,
    );
  });

  it('.get throws with "not compiled" message', async () => {
    const P = createProcess({
      path: '/x/:id',
      inject: {},
      async handler() {
        return 1;
      },
    });
    await assert.rejects(
      async () => P.get(['1']),
      /not compiled/,
    );
  });

  it('.query returns an async iterable whose next() throws', async () => {
    const P = createProcess({
      path: '/x/:id',
      inject: {},
      async handler() {
        return 1;
      },
    });
    const iter = P.query({});
    const it = iter[Symbol.asyncIterator]();
    await assert.rejects(async () => it.next(), /not compiled/);
  });

  it('.emit throws with "not compiled" message', async () => {
    const P = createProcess({
      path: '/x/:id',
      inject: {},
      async handler() {
        return 1;
      },
    });
    await assert.rejects(
      async () => P.emit('sig', [], {}),
      /not compiled/,
    );
  });

  it('ServiceDef surface (.deps, .factory) is present', () => {
    const P = createProcess({
      path: '/x',
      inject: {},
      async handler() {
        return 1;
      },
    });
    assert.ok('deps' in P);
    assert.equal(typeof (P as any).factory, 'function');
  });

  it('__config exposes the original config including path and inject', () => {
    const inject = {};
    const P = createProcess({
      path: '/foo/:bar',
      inject,
      async handler() {
        return null;
      },
    });
    const cfg = (P as any).__config;
    assert.equal(cfg.path, '/foo/:bar');
    assert.equal(cfg.inject, inject);
  });

  it('exports is initialised to undefined at definition time', () => {
    const P = createProcess({
      path: '/x',
      inject: {},
      async handler() {
        return 1;
      },
    });
    assert.equal(P.exports, undefined);
  });

  it('definition objects are independent instances', () => {
    const A = createProcess({
      path: '/a',
      inject: {},
      async handler() {
        return 1;
      },
    });
    const B = createProcess({
      path: '/b',
      inject: {},
      async handler() {
        return 2;
      },
    });
    assert.notEqual(A, B);
    assert.notEqual(A.path, B.path);
  });
});

describe('createSubProcess', () => {
  it('attaches the SUBPROCESS_DEFINITION marker', () => {
    const sp = createSubProcess({
      name: 'player',
      path: '/:playerId',
      handler: async (_playerId: string) => 'ok',
    });
    assert.equal((sp as any)[SUBPROCESS_DEFINITION], true);
  });

  it('stores config under __config', () => {
    const sp = createSubProcess({
      name: 'item',
      path: '/:itemId',
      handler: async () => null,
    });
    assert.equal((sp as any).__config.name, 'item');
    assert.equal((sp as any).__config.path, '/:itemId');
  });

  it('callable but throws until compiled', async () => {
    const sp = createSubProcess({
      name: 'x',
      path: '/:id',
      handler: async () => 1,
    });
    await assert.rejects(async () => (sp as any)('a'), /not compiled/);
  });
});

describe('generateInstanceId', () => {
  it('replaces :params with string values', () => {
    assert.equal(
      generateInstanceId('/order/:orderId/fulfillment', ['abc']),
      'order/abc/fulfillment',
    );
  });

  it('handles multiple params in order', () => {
    assert.equal(
      generateInstanceId('/org/:org/user/:user', ['a', 'b']),
      'org/a/user/b',
    );
  });

  it('accepts values with .identifier property', () => {
    const ref = { identifier: 'ent-1' };
    assert.equal(
      generateInstanceId('/order/:id', [ref]),
      'order/ent-1',
    );
  });

  it('coerces non-string identifiers to string', () => {
    assert.equal(
      generateInstanceId('/num/:n', [42]),
      'num/42',
    );
  });

  it('path with no params produces static id', () => {
    assert.equal(generateInstanceId('/ping', []), 'ping');
  });

  it('missing param throws', () => {
    assert.throws(
      () => generateInstanceId('/x/:id', []),
      /Missing parameter for :id/,
    );
  });
});

describe('resolvePath', () => {
  it('replaces :params inline preserving surrounding segments', () => {
    assert.equal(
      resolvePath('/foo/:a/bar/:b', ['1', '2']),
      '/foo/1/bar/2',
    );
  });

  it('throws on missing param', () => {
    assert.throws(() => resolvePath('/:id', []), /Missing parameter/);
  });

  it('no-param path passes through unchanged', () => {
    assert.equal(resolvePath('/static', []), '/static');
  });
});

describe('extractIdentity', () => {
  it('returns param map keyed by param name', () => {
    assert.deepEqual(
      extractIdentity('/order/:orderId/x/:subId', ['abc', '1']),
      { orderId: 'abc', subId: '1' },
    );
  });

  it('empty identity when no params', () => {
    assert.deepEqual(extractIdentity('/foo/bar', []), {});
  });

  it('throws on missing param (same as generateInstanceId)', () => {
    assert.throws(
      () => extractIdentity('/:a', []),
      /Missing parameter for :a/,
    );
  });
});
