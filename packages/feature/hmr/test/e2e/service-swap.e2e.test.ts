/**
 * HMR e2e — service method swap preserves module-level state.
 *
 * Strategy: module-scoped state (`counter`) lives in a file we never
 * edit. The service (which we DO edit) reads/writes that state. If the
 * HMR path truly hot-swaps (instead of restarting the process), the
 * counter survives the edit.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startFixture, type HarnessHandle } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '..', 'fixtures', 'basic-app');

describe('HMR e2e: service method swap', () => {
  let app: HarnessHandle;

  before(async () => {
    app = await startFixture({ fixtureDir });
  });

  after(async () => {
    await app?.shutdown();
  });

  it('original handler responds with "Hello, <name>!"', async () => {
    const body = await app.json<{ message: string }>('/hello/alice');
    assert.equal(body.message, 'Hello, alice!');
  });

  it('accumulates module-level state across requests', async () => {
    const a = await app.json<{ counter: number }>('/bump', { method: 'POST' });
    const b = await app.json<{ counter: number }>('/bump', { method: 'POST' });
    assert.equal(a.counter, 1);
    assert.equal(b.counter, 2);
  });

  it('hot-swaps the service after editing and preserves state', async () => {
    await app.edit('src/greeting.service.ts', (src) =>
      src.replace('return `Hello, ${name}!`;', 'return `Howdy, ${name}!`;'),
    );

    const greet = await app.json<{ message: string }>('/hello/alice');
    assert.equal(
      greet.message,
      'Howdy, alice!',
      'service body swap did not take effect',
    );

    // Module-level state from `state.ts` must survive the swap —
    // prev test incremented to 2. If the process had restarted, this
    // would reset to 0.
    const snap = await app.json<{ counter: number; trailLength: number }>('/snapshot');
    assert.equal(snap.counter, 2, 'module state lost — process likely restarted');
    // The swapped service should still append to the trail for new calls.
    assert.ok(snap.trailLength >= 2, 'expected trail to have entries from both pre- and post-swap calls');
  });
});
