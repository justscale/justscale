/**
 * `drainAndClose` deadline regression.
 *
 * Pre-fix the WS handler's close path was:
 *   while (ws.bufferedAmount > 0 && ws.readyState === OPEN) {
 *     await sleep(10);
 *   }
 *   ws.close(...);
 *
 * If a slow / dead client never drained, this loop ran forever and the
 * handler hung. The fix bounds it via DRAIN_DEADLINE_MS=5_000.
 *
 * These tests pin both ends:
 *   - drains promptly when buffer empties (no extra delay)
 *   - bails after the deadline if buffer never empties
 *   - exits immediately when socket leaves OPEN state
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drainAndClose, type DrainableSocket } from '../src/server.js';

class FakeSocket implements DrainableSocket {
  bufferedAmount: number;
  readyState: number;
  constructor(initialBuffered: number, initialState = 1 /* OPEN */) {
    this.bufferedAmount = initialBuffered;
    this.readyState = initialState;
  }
}

describe('drainAndClose', () => {
  it('returns immediately when buffer is already empty', async () => {
    const ws = new FakeSocket(0);
    const start = Date.now();
    await drainAndClose(ws);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `should be near-instant, took ${elapsed}ms`);
  });

  it('returns shortly after buffer empties', async () => {
    const ws = new FakeSocket(1024);
    // Drain after a short delay.
    setTimeout(() => { ws.bufferedAmount = 0; }, 30);

    const start = Date.now();
    await drainAndClose(ws, { deadlineMs: 5000, pollMs: 5 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `should resolve shortly after drain, took ${elapsed}ms`);
  });

  it('BAILS at the deadline when buffer never drains (the regression test)', async () => {
    // Buffer stays at 1024 forever — without the deadline, this loop
    // would hang the handler indefinitely.
    const ws = new FakeSocket(1024);
    const start = Date.now();
    await drainAndClose(ws, { deadlineMs: 100, pollMs: 5 });
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed >= 100 && elapsed < 250,
      `should bail near deadline (100ms), took ${elapsed}ms`,
    );
    // Buffer is still non-empty — that's the failure mode the deadline
    // protects against. The caller (handler) closes anyway.
    assert.strictEqual(ws.bufferedAmount, 1024);
  });

  it('returns immediately when socket leaves OPEN state', async () => {
    const ws = new FakeSocket(1024);
    // Simulate the client dropping mid-drain.
    setTimeout(() => { ws.readyState = 3 /* CLOSED */; }, 20);

    const start = Date.now();
    await drainAndClose(ws, { deadlineMs: 5000, pollMs: 5 });
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 200,
      `should return shortly after socket closes, took ${elapsed}ms`,
    );
  });

  it('does not loop when socket starts closed', async () => {
    const ws = new FakeSocket(9999, 3 /* CLOSED */);
    const start = Date.now();
    await drainAndClose(ws);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `should bail immediately, took ${elapsed}ms`);
  });
});
