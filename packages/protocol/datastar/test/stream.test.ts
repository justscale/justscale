import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDatastarStream,
  DATASTAR_SSE_HEADERS,
  type DatastarWritable,
} from '../src/stream.js';

function fakeWritable(): {
  chunks: string[]
  ended: boolean
  writable: DatastarWritable
} {
  const chunks: string[] = [];
  let ended = false;
  const writable: DatastarWritable = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
    },
  };
  return {
    chunks,
    get ended() { return ended; },
    writable,
  };
}

describe('createDatastarStream — on an abstract writable', () => {
  it('writes nothing before any method is called', () => {
    const fake = fakeWritable();
    createDatastarStream(fake.writable);
    assert.deepEqual(fake.chunks, []);
  });

  it('routes mergeSignals through the encoder', () => {
    const fake = fakeWritable();
    const stream = createDatastarStream(fake.writable);
    stream.mergeSignals({ n: 1 });
    assert.deepEqual(fake.chunks, [
      'event: datastar-merge-signals\ndata: signals {"n":1}\n\n',
    ]);
  });

  it('routes mergeFragments with opts through the encoder', () => {
    const fake = fakeWritable();
    const stream = createDatastarStream(fake.writable);
    stream.mergeFragments('<b>x</b>', { selector: '#t', mergeMode: 'inner' });
    assert.equal(fake.chunks.length, 1);
    assert.equal(
      fake.chunks[0],
      'event: datastar-merge-fragments\n'
      + 'data: selector #t\n'
      + 'data: mergeMode inner\n'
      + 'data: fragments <b>x</b>\n'
      + '\n',
    );
  });

  it('preserves call order across mixed methods', () => {
    const fake = fakeWritable();
    const stream = createDatastarStream(fake.writable);

    stream.mergeSignals({ a: 1 });
    stream.mergeFragments('<p>p</p>');
    stream.removeFragments('#old');
    stream.removeSignals(['foo', 'bar']);
    stream.executeScript('console.log(1)');
    stream.heartbeat();

    assert.deepEqual(fake.chunks, [
      'event: datastar-merge-signals\ndata: signals {"a":1}\n\n',
      'event: datastar-merge-fragments\ndata: fragments <p>p</p>\n\n',
      'event: datastar-remove-fragments\ndata: selector #old\n\n',
      'event: datastar-remove-signals\ndata: paths foo bar\n\n',
      'event: datastar-execute-script\ndata: script console.log(1)\n\n',
      ': heartbeat\n\n',
    ]);
  });

  it('close() calls end() on the underlying writable', () => {
    const fake = fakeWritable();
    const stream = createDatastarStream(fake.writable);
    stream.close();
    assert.equal(fake.ended, true);
  });

  it('does not write or end when writable.destroyed is true', () => {
    const chunks: string[] = [];
    let ended = false;
    const writable: DatastarWritable = {
      destroyed: true,
      write(c) { chunks.push(c); return true; },
      end() { ended = true; },
    };
    const stream = createDatastarStream(writable);
    stream.mergeSignals({ x: 1 });
    stream.close();
    assert.deepEqual(chunks, []);
    assert.equal(ended, false);
  });

  it('writes after close() are silent no-ops, not write-after-end throws', () => {
    // The underlying sink throws if written to after end() — like a real
    // ServerResponse (ERR_STREAM_WRITE_AFTER_END). The stream must guard.
    const chunks: string[] = [];
    let ended = false;
    const writable: DatastarWritable = {
      write(c) {
        if (ended) throw new Error('write after end');
        chunks.push(c);
        return true;
      },
      end() { ended = true; },
    };
    const stream = createDatastarStream(writable);
    stream.mergeSignals({ a: 1 });
    stream.close();
    assert.equal(ended, true);
    // These must NOT throw, and must not reach the sink.
    assert.doesNotThrow(() => stream.mergeSignals({ b: 2 }));
    assert.doesNotThrow(() => stream.mergeFragments('<p>late</p>'));
    assert.doesNotThrow(() => stream.heartbeat());
    assert.doesNotThrow(() => stream.close()); // idempotent
    assert.deepEqual(chunks, [
      'event: datastar-merge-signals\ndata: signals {"a":1}\n\n',
    ]);
  });

  it('stops writing once the sink reports writableEnded (ended elsewhere)', () => {
    const chunks: string[] = [];
    const writable = {
      writableEnded: false,
      write(c: string) { chunks.push(c); return true; },
      end() {},
    };
    const stream = createDatastarStream(writable as unknown as DatastarWritable);
    stream.mergeSignals({ a: 1 });
    writable.writableEnded = true; // response ended by some other path
    stream.mergeSignals({ b: 2 });
    assert.deepEqual(chunks, [
      'event: datastar-merge-signals\ndata: signals {"a":1}\n\n',
    ]);
  });
});

describe('createDatastarStream — on a ServerResponse-like', () => {
  it('writes SSE headers on construction when headers have not yet been sent', () => {
    const headerCalls: Array<{ status: number; headers: Record<string, string> }> = [];
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      destroyed: false,
      writeHead(status: number, headers: Record<string, string>) {
        headerCalls.push({ status, headers });
        this.headersSent = true;
      },
      write(chunk: string) { chunks.push(chunk); return true; },
      end() {},
    };

    // Cast is safe — this stub matches the ServerResponse shape the guard checks.
    const stream = createDatastarStream(res as unknown as DatastarWritable);

    assert.equal(headerCalls.length, 1, 'writeHead should be called exactly once');
    assert.equal(headerCalls[0].status, 200);
    assert.deepEqual(headerCalls[0].headers, DATASTAR_SSE_HEADERS);

    // Sanity: data chunks still pass through after headers.
    stream.mergeSignals({ ok: true });
    assert.equal(
      chunks[0],
      'event: datastar-merge-signals\ndata: signals {"ok":true}\n\n',
    );
  });

  it('does NOT write headers if headersSent is already true', () => {
    const headerCalls: unknown[] = [];
    const res = {
      statusCode: 200,
      headersSent: true,
      destroyed: false,
      writeHead(status: number, headers: Record<string, string>) {
        headerCalls.push({ status, headers });
      },
      write() { return true; },
      end() {},
    };

    createDatastarStream(res as unknown as DatastarWritable);
    assert.equal(headerCalls.length, 0);
  });

  it('exposes the required SSE headers verbatim', () => {
    assert.equal(DATASTAR_SSE_HEADERS['Content-Type'], 'text/event-stream');
    assert.equal(DATASTAR_SSE_HEADERS['Cache-Control'], 'no-cache');
    assert.equal(DATASTAR_SSE_HEADERS['Connection'], 'keep-alive');
    assert.equal(DATASTAR_SSE_HEADERS['X-Accel-Buffering'], 'no');
  });
});
