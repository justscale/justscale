import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { SignalRepository, createSignalRepository } from '../src/repository.js';
import type { DatastarStream } from '../src/types.js';

type Call =
  | { kind: 'mergeSignals'; data: Record<string, unknown> }
  | { kind: 'mergeFragments'; html: string }
  | { kind: 'removeFragments'; selector: string }
  | { kind: 'removeSignals'; paths: string[] | string }
  | { kind: 'executeScript'; script: string };

function recordingStream(): { stream: DatastarStream; calls: Call[] } {
  const calls: Call[] = [];
  const stream: DatastarStream = {
    mergeSignals(data) { calls.push({ kind: 'mergeSignals', data }); },
    mergeFragments(htmlStr) { calls.push({ kind: 'mergeFragments', html: htmlStr }); },
    removeFragments(selector) { calls.push({ kind: 'removeFragments', selector }); },
    removeSignals(paths) { calls.push({ kind: 'removeSignals', paths }); },
    executeScript(script) { calls.push({ kind: 'executeScript', script }); },
  };
  return { stream, calls };
}

const CounterSchema = z.object({
  count: z.number().default(0),
  label: z.string().default('tick'),
});
type Counter = z.infer<typeof CounterSchema>;

describe('SignalRepository', () => {
  it('createSignalRepository returns a SignalRepository instance', () => {
    const { stream } = recordingStream();
    const repo = createSignalRepository(CounterSchema, stream);
    assert.ok(repo instanceof SignalRepository);
  });

  it('create() applies zod defaults', () => {
    const { stream } = recordingStream();
    const repo = createSignalRepository(CounterSchema, stream);
    const model = repo.create();
    assert.equal(model.count, 0);
    assert.equal(model.label, 'tick');
  });

  it('create() accepts partial input and fills defaults', () => {
    const { stream } = recordingStream();
    const repo = createSignalRepository(CounterSchema, stream);
    const model = repo.create({ count: 7 });
    assert.equal(model.count, 7);
    assert.equal(model.label, 'tick');
  });

  it('save() is a no-op on a clean model and returns false', () => {
    const { stream, calls } = recordingStream();
    const repo = createSignalRepository(CounterSchema, stream);
    const model = repo.create({ count: 1, label: 'a' });

    const saved = repo.save(model);
    assert.equal(saved, false);
    assert.equal(calls.length, 0, 'stream must not be touched when nothing is dirty');
  });

  it('save() emits only dirty top-level fields and marks the model clean', () => {
    const { stream, calls } = recordingStream();
    const repo = createSignalRepository<Counter>(CounterSchema, stream);
    const model = repo.create({ count: 0, label: 'a' });

    model.count = 5;

    const saved = repo.save(model);
    assert.equal(saved, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'mergeSignals');
    assert.deepEqual((calls[0] as { data: Record<string, unknown> }).data, { count: 5 });

    // A second save with no further mutation must be a no-op.
    const savedAgain = repo.save(model);
    assert.equal(savedAgain, false);
    assert.equal(calls.length, 1);
  });

  it('save() emits multiple dirty keys together', () => {
    const { stream, calls } = recordingStream();
    const repo = createSignalRepository<Counter>(CounterSchema, stream);
    const model = repo.create({ count: 0, label: 'a' });

    model.count = 9;
    model.label = 'z';

    repo.save(model);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      (calls[0] as { data: Record<string, unknown> }).data,
      { count: 9, label: 'z' },
    );
  });

  it('saveAll() emits every top-level field regardless of dirty state', () => {
    const { stream, calls } = recordingStream();
    const repo = createSignalRepository<Counter>(CounterSchema, stream);
    const model = repo.create({ count: 3, label: 'init' });

    repo.saveAll(model);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'mergeSignals');
    assert.deepEqual(
      (calls[0] as { data: Record<string, unknown> }).data,
      { count: 3, label: 'init' },
    );
  });

  it('saveAll() clears dirty state so a subsequent save() is a no-op', () => {
    const { stream, calls } = recordingStream();
    const repo = createSignalRepository<Counter>(CounterSchema, stream);
    const model = repo.create();

    model.count = 42;
    repo.saveAll(model);
    assert.equal(calls.length, 1);

    const saved = repo.save(model);
    assert.equal(saved, false);
    assert.equal(calls.length, 1, 'save() after saveAll() must not emit again');
  });
});
