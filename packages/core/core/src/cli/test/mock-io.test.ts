/**
 * Tests for createMockIO — the test-friendly CliIO implementation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIO } from '../io.js';

describe('createMockIO', () => {
  it('log/warn/debug collect into output[]', () => {
    const io = createMockIO();
    io.log('hi');
    io.warn('careful');
    io.debug('dbg');
    assert.deepEqual(io.output, ['hi', '[WARN] careful', '[DEBUG] dbg']);
  });

  it('error collects into errors[], not output', () => {
    const io = createMockIO();
    io.error('bad');
    assert.deepEqual(io.errors, ['bad']);
    assert.deepEqual(io.output, []);
  });

  it('result() pushes to results[] and is typed via generic', () => {
    const io = createMockIO<{ ok: boolean }>();
    io.result({ ok: true });
    assert.deepEqual(io.results, [{ ok: true }]);
  });

  it('prompt returns the next input in the queue', async () => {
    const io = createMockIO();
    io.setInputs(['alice', 'bob']);
    assert.equal(await io.prompt('name?'), 'alice');
    assert.equal(await io.prompt('next?'), 'bob');
  });

  it('prompt falls back to default when no input left', async () => {
    const io = createMockIO();
    assert.equal(await io.prompt('name?', 'default'), 'default');
  });

  it('confirm with no input returns the default', async () => {
    const io = createMockIO();
    assert.equal(await io.confirm('ok?', true), true);
    assert.equal(await io.confirm('ok?', false), false);
  });

  it('confirm returns true for "y"/"yes"', async () => {
    const io = createMockIO();
    io.setInputs(['y']);
    assert.equal(await io.confirm('ok?'), true);
    io.setInputs(['yes']);
    assert.equal(await io.confirm('ok?'), true);
  });

  it('confirm returns false for empty answer with no default', async () => {
    const io = createMockIO();
    io.setInputs(['']);
    // Empty string doesn't startWith('y') -> false
    assert.equal(await io.confirm('ok?'), false);
  });

  it('select returns value by 1-based index', async () => {
    const io = createMockIO();
    io.setInputs(['2']);
    assert.equal(await io.select('?', ['a', 'b', 'c']), 'b');
  });

  it('select falls back to first choice when index invalid', async () => {
    const io = createMockIO();
    io.setInputs(['99']);
    assert.equal(await io.select('?', ['a', 'b', 'c']), 'a');
  });

  it('multiSelect returns chosen items', async () => {
    const io = createMockIO();
    io.setInputs(['1,3']);
    assert.deepEqual(await io.multiSelect('?', ['a', 'b', 'c']), ['a', 'c']);
  });

  it('password reads from input queue', async () => {
    const io = createMockIO();
    io.setInputs(['secret']);
    assert.equal(await io.password('?'), 'secret');
  });

  it('table/hr/newline push markers into output', () => {
    const io = createMockIO();
    io.table([{ a: 1, b: 2 }]);
    io.hr();
    io.newline();
    assert.ok(io.output.some((o) => o.startsWith('[TABLE]')));
    assert.ok(io.output.includes('---'));
    assert.ok(io.output.includes(''));
  });

  it('isInteractive=false, isVerbose=false by default', () => {
    const io = createMockIO();
    assert.equal(io.isInteractive, false);
    assert.equal(io.isVerbose, false);
  });

  it('progress and spinner return no-op interfaces', () => {
    const io = createMockIO();
    const p = io.progress('x');
    assert.doesNotThrow(() => p.update(50));
    assert.doesNotThrow(() => p.complete());
    const s = io.spinner('y');
    assert.doesNotThrow(() => s.text('ok'));
    assert.doesNotThrow(() => s.success());
    assert.doesNotThrow(() => s.stop());
  });
});
