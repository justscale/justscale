import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { getModelInternals } from '@justscale/observable';

import { createRouteFactories } from '@justscale/core/plugin';

import {
  Watch,
  WATCH_ROUTE,
  html,
  rawHtml,
  SignalRepository,
  createSignalRepository,
  encodeMergeSignals,
  encodeMergeFragments,
  encodeRemoveFragments,
  encodeRemoveSignals,
  encodeExecuteScript,
  encodeHeartbeat,
  createDatastarStream,
  DATASTAR_SSE_HEADERS,
  handleWatch,
  isWatchRoute,
} from '../src/index.js';
import type { DatastarStream } from '../src/types.js';

describe('@justscale/datastar public surface', () => {
  it('re-exports Watch, html, rawHtml, SignalRepository, createSignalRepository', () => {
    assert.equal(typeof Watch, 'function');
    assert.equal(typeof html, 'function');
    assert.equal(typeof rawHtml, 'function');
    assert.equal(typeof SignalRepository, 'function');
    assert.equal(typeof createSignalRepository, 'function');
  });

  it('exports the datastar SSE wire-format encoders', () => {
    // These used to be missing — consumers had to hand-roll the SSE bytes.
    // The package now ships a real producer, so all six encoders must be
    // present on the public surface.
    assert.equal(typeof encodeMergeSignals, 'function');
    assert.equal(typeof encodeMergeFragments, 'function');
    assert.equal(typeof encodeRemoveFragments, 'function');
    assert.equal(typeof encodeRemoveSignals, 'function');
    assert.equal(typeof encodeExecuteScript, 'function');
    assert.equal(typeof encodeHeartbeat, 'function');
  });

  it('exports the stream wrapper and its default SSE headers', () => {
    assert.equal(typeof createDatastarStream, 'function');
    assert.equal(typeof DATASTAR_SSE_HEADERS, 'object');
    assert.equal(DATASTAR_SSE_HEADERS['Content-Type'], 'text/event-stream');
  });

  it('exports the HTTP-handler wiring helpers and the Watch-route marker symbol', () => {
    assert.equal(typeof handleWatch, 'function');
    assert.equal(typeof isWatchRoute, 'function');
    assert.equal(typeof WATCH_ROUTE, 'symbol');
  });

  it('registers the Watch route factory in the core plugin registry on import', () => {
    const factories = createRouteFactories<Record<string, unknown>>() as unknown as Record<
      string,
      unknown
    >;
    assert.equal(
      factories.Watch,
      Watch,
      'importing @justscale/datastar must register Watch in the core route-factory registry',
    );
  });

  it('integration: a Watch generator that mutates + diffs via SignalRepository produces one merge per yield', async () => {
    const merges: Record<string, unknown>[] = [];
    const stream: DatastarStream = {
      mergeSignals(data) { merges.push(data); },
      mergeFragments() {},
      removeFragments() {},
      removeSignals() {},
      executeScript() {},
    };

    const CounterSchema = z.object({
      count: z.number().default(0),
    });

    // Drive the stream via a model-backed diff: mutate the model, yield only
    // the dirty delta. This is the intended shape of a datastar Watch handler.
    const route = Watch('/counter', async function* ({ stream: s }) {
      const repo = createSignalRepository(CounterSchema, s);
      const model = repo.create();

      model.count = 1;
      yield snapshot(model);

      model.count = 2;
      yield snapshot(model);
    }) as { handler: (ctx: unknown) => Promise<void> };

    await route.handler({ deps: {}, params: {}, signals: {}, stream });

    assert.equal(merges.length, 2);
    assert.deepEqual(merges[0], { count: 1 });
    assert.deepEqual(merges[1], { count: 2 });
  });

  it('integration: repo.save() from inside a Watch generator reaches the same stream', async () => {
    const merges: Record<string, unknown>[] = [];
    const stream: DatastarStream = {
      mergeSignals(data) { merges.push(data); },
      mergeFragments() {},
      removeFragments() {},
      removeSignals() {},
      executeScript() {},
    };

    const Schema = z.object({ n: z.number().default(0) });

    const route = Watch('/via-save', async function* ({ stream: s }) {
      const repo = createSignalRepository(Schema, s);
      const model = repo.create();
      model.n = 10;
      // repo.save() writes directly to the stream (not via yield).
      repo.save(model);
      // Also yield a trailing delta via the generator path to exercise both.
      model.n = 11;
      yield snapshot(model);
    }) as { handler: (ctx: unknown) => Promise<void> };

    await route.handler({ deps: {}, params: {}, signals: {}, stream });

    assert.equal(merges.length, 2, 'one merge via save(), one via yield');
    assert.deepEqual(merges[0], { n: 10 });
    assert.deepEqual(merges[1], { n: 11 });
  });
});

function snapshot<T>(model: T): Record<string, unknown> {
  const internals = getModelInternals(model as never);
  const data = internals.getDirtyData() as Record<string, unknown>;
  internals.markClean();
  return data;
}
