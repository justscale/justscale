/**
 * HMR e2e — sub-apps survive rebuilds AND their scoped services get
 * hot-swapped.
 *
 * Two regressions combined in one fixture:
 *
 *   1. Rebuild used to throw "Sub-app already compiled — cannot inherit
 *      build context" because HMR's throwaway parent re-entered the
 *      compose loop on the same module-level sub-app singleton. The
 *      compose loop now skips already-compiled sub-apps.
 *
 *   2. Services registered inside a sub-app live on the sub-app's
 *      container, not the root's. The watcher used to only probe the
 *      root via `dev.hasServiceDef`, silently dropping sub-app services
 *      — edits to them would re-import but never swap anywhere. The
 *      watcher now walks the whole `app.subApps` tree at boot, and
 *      rebuild dispatches `replaceInstance` to the owning container.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startFixture, type HarnessHandle } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '..', 'fixtures', 'basic-app');

describe('HMR e2e: sub-app survives rebuild', () => {
  let app: HarnessHandle;

  before(async () => {
    app = await startFixture({ fixtureDir });
  });

  after(async () => {
    await app?.shutdown();
  });

  it('serves the sub-app route on boot', async () => {
    const body = await app.json<{ ok: boolean; via: string; scoped: string }>('/sub/ping');
    assert.equal(body.ok, true);
    assert.equal(body.via, 'Hello, sub!');
    assert.equal(body.scoped, 'sub-v1');
  });

  it('rebuild after editing unrelated service does not crash the process', async () => {
    await app.edit('src/greeting.service.ts', (src) =>
      src.replace('return `Hello, ${name}!`;', 'return `Howdy, ${name}!`;'),
    );

    const crashed = app.logs.some((l) =>
      l.includes('Sub-app already compiled'),
    );
    assert.equal(
      crashed,
      false,
      `expected no sub-app compose error; recent logs:\n${app.logs.slice(-30).join('\n')}`,
    );

    const body = await app.json<{ ok: boolean; via: string }>('/sub/ping');
    assert.equal(body.ok, true);
    assert.equal(
      body.via,
      'Howdy, sub!',
      'sub-app routes should see the hot-swapped root-scope service',
    );
  });

  it('hot-swaps a service that lives inside the sub-app scope', async () => {
    // Baseline before this edit: SubScopedService.speak returns 'sub-v1'.
    const before = await app.json<{ scoped: string }>('/sub/ping');
    assert.equal(before.scoped, 'sub-v1');

    await app.edit('src/sub.service.ts', (src) =>
      src.replace("return 'sub-v1';", "return 'sub-v2';"),
    );

    const after = await app.json<{ scoped: string }>('/sub/ping');
    assert.equal(
      after.scoped,
      'sub-v2',
      'sub-app scoped service did not hot-swap — watcher likely missed the sub-app container',
    );

    const replacedLog = app.logs.some((l) =>
      l.includes('replaced src/sub.service.ts#SubScopedService'),
    );
    assert.ok(
      replacedLog,
      `expected "replaced" log for SubScopedService; recent logs:\n${app.logs.slice(-20).join('\n')}`,
    );
  });
});
