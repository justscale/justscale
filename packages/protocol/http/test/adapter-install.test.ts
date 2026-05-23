import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale, { createController } from '@justscale/core';
import { Get, Post } from '../src/index.js';
import { HTTP_ADAPTER } from '../src/adapter.js';
import { defaultHttpConfig } from '../src/testing.js';

describe('HTTP_ADAPTER install', () => {
  it('registers HTTP_ADAPTER once when a controller uses Get()', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        one: Get('/one').handle(() => undefined),
      }),
    });

    const built = JustScale()
      .add(defaultHttpConfig)
      .add(Ctrl)
      .build();

    const app = built.compile();
    await app.ready;

    assert.strictEqual(app.adapters.length, 1);
    assert.strictEqual(app.adapters[0], HTTP_ADAPTER);
  });

  it('dedupes via Set identity across many routes', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        a: Get('/a').handle(() => undefined),
        b: Get('/b').handle(() => undefined),
        c: Post('/c').handle(() => undefined),
        d: Post('/d').handle(() => undefined),
        e: Post('/e').handle(() => undefined),
      }),
    });

    const built = JustScale()
      .add(defaultHttpConfig)
      .add(Ctrl)
      .build();

    const app = built.compile();
    await app.ready;

    assert.strictEqual(app.adapters.length, 1);
    assert.strictEqual(app.adapters[0], HTTP_ADAPTER);
  });

  it('stamps __transportRequires brand on the RouteDef', () => {
    const route = Get('/brand').handle(() => undefined);
    assert.ok(route.__transportRequires);
    assert.strictEqual(route.__transportRequires.length, 1);
  });
});
