/**
 * HMR e2e — syntax error recovery.
 *
 * When the user saves a file with a syntax error, the previously-running
 * service MUST keep serving. The child process MUST NOT crash. When the
 * file is fixed on the next save, the new version takes over.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { startFixture, type HarnessHandle } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '..', 'fixtures', 'basic-app');

describe('HMR e2e: syntax error recovery', () => {
  let app: HarnessHandle;

  before(async () => {
    app = await startFixture({ fixtureDir });
  });

  after(async () => {
    await app?.shutdown();
  });

  it('serves the original handler', async () => {
    const body = await app.json<{ message: string }>('/hello/alice');
    assert.equal(body.message, 'Hello, alice!');
  });

  it('survives a syntax-error save and keeps serving old code', async () => {
    // Write garbage directly to the WORKING copy — not through
    // `harness.edit`, because that waits for `[hmr] applied` which
    // shouldn't fire for a broken rebuild.
    const target = join(app.workDir, 'src/greeting.service.ts');
    await writeFile(
      target,
      'export const Greeting this is not valid typescript {{{',
      'utf8',
    );

    // Give HMR its debounce window + a beat to try and fail the rebuild.
    await new Promise((r) => setTimeout(r, 1_000));

    // The child should not have crashed. Old service still responds.
    const res = await app.fetch('/hello/alice');
    assert.equal(res.status, 200, 'process crashed or route gone');
    const body = (await res.json()) as { message: string };
    assert.equal(body.message, 'Hello, alice!', 'old handler should still serve during broken state');

    // Logs should mention the rebuild failure — keeps the diagnostic loud.
    const hadFailureLog = app.logs.some(
      (l) => /rebuild failed|hmr.*error|keeping previous/i.test(l),
    );
    assert.ok(
      hadFailureLog,
      `expected an HMR failure log line. Last 20 logs:\n${app.logs.slice(-20).join('\n')}`,
    );
  });

  it('recovers when the file is fixed', async () => {
    // Previous test left the service file as garbage. Replace the
    // whole file with a valid new version and wait for HMR to land it.
    await app.edit('src/greeting.service.ts', () => `import { defineService } from '@justscale/core';
import { state } from './state.js';

export class GreetingService extends defineService({
  inject: {},
  factory: () => ({
    greet(name: string): string {
      state.trail.push(\`greet:\${name}\`);
      return \`Welcome, \${name}!\`;
    },
    bumpCounter(): number {
      state.counter += 1;
      return state.counter;
    },
    snapshot() {
      return { counter: state.counter, trailLength: state.trail.length };
    },
  }),
}) {}
`);
    const body = await app.json<{ message: string }>('/hello/alice');
    assert.equal(body.message, 'Welcome, alice!');
  });
});
