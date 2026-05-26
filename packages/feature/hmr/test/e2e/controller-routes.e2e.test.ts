/**
 * HMR e2e — controller edits: add / remove routes.
 *
 * New route should become live without restart; removed route should
 * start returning 404. Module-level state is checked at the boundary
 * to prove the process never bounced.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startFixture, type HarnessHandle } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '..', 'fixtures', 'basic-app');

describe('HMR e2e: controller route add/remove', () => {
  let app: HarnessHandle;

  before(async () => {
    app = await startFixture({ fixtureDir });
  });

  after(async () => {
    await app?.shutdown();
  });

  it('a route that does not exist yet returns 404', async () => {
    const res = await app.fetch('/shout/alice');
    assert.equal(res.status, 404);
  });

  it('bumps the counter so we can detect a restart later', async () => {
    const a = await app.json<{ counter: number }>('/bump', { method: 'POST' });
    const b = await app.json<{ counter: number }>('/bump', { method: 'POST' });
    assert.equal(b.counter, 2);
  });

  it('adds a new route via controller edit and serves it', async () => {
    await app.edit('src/greeting.controller.ts', (src) =>
      src.replace(
        `    snapshot: Get('/snapshot').handle(({ res }) => {
      res.json(greet.snapshot());
    }),`,
        `    snapshot: Get('/snapshot').handle(({ res }) => {
      res.json(greet.snapshot());
    }),

    shout: Get('/shout/:name').handle(({ params, res }) => {
      res.json({ message: greet.greet(params.name).toUpperCase() });
    }),`,
      ),
    );

    const body = await app.json<{ message: string }>('/shout/alice');
    assert.equal(body.message, 'HELLO, ALICE!');

    // Counter from earlier test MUST survive — no restart.
    const snap = await app.json<{ counter: number }>('/snapshot');
    assert.equal(snap.counter, 2, 'counter reset — process likely restarted');
  });

  it('adds a brand-new controller via .add() and its routes serve', async () => {
    // Baseline: /admin/* doesn't exist yet. Without this explicit
    // assertion a stale route from somewhere else could give a false
    // positive after the edit.
    assert.equal(
      (await app.fetch('/admin/ping')).status,
      404,
      'baseline: /admin/* must not be registered pre-edit',
    );

    const logsBefore = app.logs.length;
    await app.edit('src/app.ts', (src) =>
      src.replace(
        '.add(GreetingController),',
        '.add(GreetingController)\n    .add(AdminController),',
      ),
    );

    // The rebuild must have added exactly one thing, and it must be a
    // controller. Without this check, the body assertion below could
    // pass because some OTHER mechanism (restart, stale cache) wired
    // the route — we want proof HMR's add-new path fired.
    const newLogs = app.logs.slice(logsBefore);
    const addedController = newLogs.find((l) =>
      l.includes('added controller src/admin.controller.ts#AdminController'),
    );
    assert.ok(addedController, `expected add-controller log, got: ${newLogs.filter((l) => l.includes('[hmr]')).join(' | ')}`);

    const body = await app.json<{ ok: boolean; counter: number }>('/admin/ping');
    assert.equal(body.ok, true);
    // Counter==2 proves two things at once:
    //  (a) AdminController was resolved against the LIVE container
    //      (so its inject picked up the pre-existing GreetingService),
    //  (b) the process didn't restart (would have reset counter to 0).
    assert.equal(
      body.counter,
      2,
      'counter != 2 means AdminController got a fresh GreetingService (wrong container) or the process restarted',
    );

    // Pre-existing route still answers — live app's controllers array
    // wasn't stomped.
    const snap = await app.json<{ counter: number }>('/snapshot');
    assert.equal(snap.counter, 2);
  });

  it('editing a just-added controller goes through the replace path, not add', async () => {
    // The earlier test added AdminController. Editing its handler
    // should now surface as a replace (factory swap in place), NOT a
    // second add — the stable ID should already be in the live map.
    // If this fires as an add, we'd have two controllers with the
    // same routes on app.controllers, and the counter on the second
    // response might be from either instance.
    const logsBefore = app.logs.length;
    await app.edit('src/admin.controller.ts', (src) =>
      src.replace(
        'res.json({ ok: true, counter: greet.snapshot().counter });',
        "res.json({ ok: true, counter: greet.snapshot().counter, tag: 'edited' });",
      ),
    );

    const newLogs = app.logs.slice(logsBefore);
    const replaced = newLogs.find((l) =>
      l.includes('replaced src/admin.controller.ts#AdminController'),
    );
    const addedAgain = newLogs.find((l) =>
      l.includes('added controller src/admin.controller.ts#AdminController'),
    );
    assert.ok(replaced, `expected replaced log for AdminController, got: ${newLogs.filter((l) => l.includes('[hmr]')).join(' | ')}`);
    assert.equal(addedAgain, undefined, 'AdminController was added a second time — stable ID not saved after first add');

    const body = await app.json<{ ok: boolean; counter: number; tag?: string }>('/admin/ping');
    assert.equal(body.tag, 'edited', 'response body missing the new field — factory swap didn\'t take');
    assert.equal(body.counter, 2, 'counter reset — process restart');
  });

  it('adds a brand-new service + controller in one edit and DI wires them up', async () => {
    // Baseline: nothing under /counter/* exists yet.
    assert.equal((await app.fetch('/counter')).status, 404, 'baseline: /counter 404');
    assert.equal((await app.fetch('/counter/bump')).status, 404, 'baseline: /counter/bump 404');

    const logsBefore = app.logs.length;
    await app.edit('src/app.ts', (src) =>
      src.replace(
        '.add(AdminController),',
        '.add(AdminController)\n    .add(CounterService)\n    .add(CounterController),',
      ),
    );

    // HMR should log both an add-service and an add-controller line.
    // Missing either = silent partial success.
    const newLogs = app.logs.slice(logsBefore);
    const addedService = newLogs.find((l) => l.includes('added service src/counter.service.ts#CounterService'));
    const addedController = newLogs.find((l) => l.includes('added controller src/counter.controller.ts#CounterController'));
    assert.ok(addedService, `expected add-service log, got: ${newLogs.filter((l) => l.includes('[hmr]')).join(' | ')}`);
    assert.ok(addedController, `expected add-controller log, got: ${newLogs.filter((l) => l.includes('[hmr]')).join(' | ')}`);

    // Singleton proof: two bumps on the same service must produce 1
    // then 2. If CounterController got a fresh service per request,
    // the second bump would also return 1.
    const first = await app.json<{ value: number }>('/counter/bump');
    assert.equal(first.value, 1, 'first bump should yield 1 on a fresh counter');
    const second = await app.json<{ value: number }>('/counter/bump');
    assert.equal(second.value, 2, 'counter lost singleton across requests (new instance per resolve?)');
    const read = await app.json<{ value: number }>('/counter');
    assert.equal(read.value, 2, 'read-side sees separate instance from write-side');

    // Process didn't restart: GreetingService's bump counter survives.
    const snap = await app.json<{ counter: number }>('/snapshot');
    assert.equal(snap.counter, 2, 'GreetingService counter reset — process restarted');
  });

  it('refuses to add a service whose dep is missing', async () => {
    // ParentService injects ChildService. Try to add ParentService
    // WITHOUT ChildService — the rebuild's `.build()` step runs
    // `validateDependencies`, which must reject the graph and abort
    // the rebuild. Nothing lands in the live container; routes from
    // previous tests keep answering.
    const snapBefore = await app.json<{ counter: number }>('/snapshot');
    assert.equal(
      (await app.fetch('/loud/eve')).status,
      404,
      'baseline: /loud/* not registered yet',
    );

    const logsBefore = app.logs.length;
    await app.edit('src/app.ts', (src) =>
      src.replace(
        '.add(CounterController),',
        // Only ParentService — its ChildService dep is intentionally
        // absent. If HMR silently adds it anyway, either the rebuild
        // log will show `added=1` (caught here) or a later route will
        // crash at runtime (caught later).
        '.add(CounterController)\n    .add(ParentService),',
      ),
    );

    const newLogs = app.logs.slice(logsBefore);
    const buildFailure = newLogs.find((l) =>
      l.includes('rebuild failed') || l.includes('Missing dependencies'),
    );
    assert.ok(
      buildFailure,
      `expected a rebuild-failed log after missing-dep add, got: ${newLogs.filter((l) => l.includes('[hmr]')).join(' | ')}`,
    );

    // The validator should have aborted before `added` incremented.
    const addedLog = newLogs.find((l) => /rebuild complete .*added=[1-9]/.test(l));
    assert.equal(addedLog, undefined, 'no service should have been added');

    // Pre-existing state intact.
    const snapAfter = await app.json<{ counter: number }>('/snapshot');
    assert.equal(snapAfter.counter, snapBefore.counter);

    // Revert the broken edit so the next test's find-and-replace
    // anchor still matches. Rebuild that follows will be a no-op
    // (no stable IDs changed), so live container stays clean.
    await app.edit('src/app.ts', (src) =>
      src.replace(
        '.add(CounterController)\n    .add(ParentService),',
        '.add(CounterController),',
      ),
    );
  });

  it('adds a service-to-service DI chain in one edit', async () => {
    // All three are freshly .add()'d at once. ParentService's
    // `inject: { child: ChildService }` forces HMR's add-new path
    // to resolve a service dep through the live container, not
    // just wire controllers.

    // Baseline.
    assert.equal((await app.fetch('/loud/alice')).status, 404, 'baseline: /loud/* 404');

    const logsBefore = app.logs.length;
    await app.edit('src/app.ts', (src) =>
      src.replace(
        '.add(CounterController),',
        '.add(CounterController)\n    .add(ChildService)\n    .add(ParentService)\n    .add(LoudController),',
      ),
    );

    // All three components should show up in the add log: if any one
    // is missing, a later resolve would blow up — but only the
    // controller resolve throws loudly in my code; a missing service
    // registration would stay silent. Explicit check protects both.
    const newLogs = app.logs.slice(logsBefore);
    const addedChild = newLogs.find((l) => l.includes('added service src/child.service.ts#ChildService'));
    const addedParent = newLogs.find((l) => l.includes('added service src/parent.service.ts#ParentService'));
    const addedLoud = newLogs.find((l) => l.includes('added controller src/loud.controller.ts#LoudController'));
    assert.ok(addedChild, `expected ChildService add log, got: ${newLogs.filter((l) => l.includes('[hmr]')).join(' | ')}`);
    assert.ok(addedParent, `expected ParentService add log, got: ${newLogs.filter((l) => l.includes('[hmr]')).join(' | ')}`);
    assert.ok(addedLoud, `expected LoudController add log, got: ${newLogs.filter((l) => l.includes('[hmr]')).join(' | ')}`);

    // The response value proves the chain end-to-end: LoudController
    // called parent.greetLoud → parent called child.whisper → got
    // "hi alice" → upcased → "HI ALICE". If any link had failed we
    // either get 500 or a wrong string.
    const body = await app.json<{ message: string }>('/loud/alice');
    assert.equal(body.message, 'HI ALICE');

    // Different name, same chain — catches a handler that hardcoded
    // the string.
    const body2 = await app.json<{ message: string }>('/loud/bob');
    assert.equal(body2.message, 'HI BOB');

    // No restart: GreetingService state preserved from earlier tests,
    // AND CounterService state preserved from the immediately prior
    // test (value==2 after two bumps there).
    const snap = await app.json<{ counter: number }>('/snapshot');
    assert.equal(snap.counter, 2, 'GreetingService counter reset — process restarted');
    const counter = await app.json<{ value: number }>('/counter');
    assert.equal(counter.value, 2, 'CounterService state lost — process restarted or service re-instantiated');
  });

  it('removes a route and it starts 404-ing', async () => {
    await app.edit('src/greeting.controller.ts', (src) =>
      src.replace(
        /\s+bump: Post\('\/bump'\)\.handle\(\(\{ res \}\) => \{\s+res\.json\(\{ counter: greet\.bumpCounter\(\) \}\);\s+\}\),/,
        '',
      ),
    );

    const res = await app.fetch('/bump', { method: 'POST' });
    assert.equal(res.status, 404);

    // /snapshot still works; counter still 2.
    const snap = await app.json<{ counter: number }>('/snapshot');
    assert.equal(snap.counter, 2);
  });
});
