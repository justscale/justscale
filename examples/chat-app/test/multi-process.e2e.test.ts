/**
 * THE cross-process e2e.
 *
 * Spawns two actual Node processes — each running the production chat-app
 * bound to a different port but pointed at the same Postgres database.
 * Proves the framework doesn't cheat with shared memory: instance A on
 * :6301 and instance B on :6302 coordinate purely through Postgres
 * (shared tables + LISTEN/NOTIFY + advisory locks).
 *
 * Flow:
 *   1. Test runs migrations once in-process against the shared DB.
 *   2. Spawn worker A and worker B; wait for each to print `READY <port>`.
 *   3. Register alice through A's /auth/register, bob through B's.
 *   4. Alice creates a room via A; bob joins via B.
 *   5. Both open a WebSocket to /rooms/:room/ws on their respective ports.
 *   6. Alice posts on A; bob's socket on B receives the message event.
 *   7. Bob posts on B; alice's socket on A receives it too. (Same sockets.)
 *
 * Requires a running Postgres (`docker compose up -d`). The shared DB is
 * created fresh per-run and dropped in `after`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import postgres from 'postgres';

import { createEnvironment, HardcodedVault, buildProviders } from '@justscale/core';
import { httpEnv } from '@justscale/http';
import {
  postgresProcessEnv,
  postgresMigrationEnv,
  postgresMigrationDevEnv,
  postgresSecret,
  MigrationRunnerService,
} from '@justscale/postgres';

import { appEnv, userFlagsEnv, type AppEnv } from '../src/env-contract.js';
import makeApp from '../src/app.js';

// NOTE: deliberately NOT importing '@justscale/postgres/virtual/migrations'
// here -- that loader resolves migrations from process.cwd()/migrations,
// which only works when the test runner is invoked from the chat-app dir.
// When run from the repo root (full pnpm test), cwd is wrong and the
// registry stays empty, so MigrationRunner.migrate() becomes a no-op and
// the spawned workers serve traffic against an empty schema. We load the
// migrations explicitly by absolute path below in `before`.
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

async function loadChatAppMigrations(): Promise<void> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && f !== 'index.ts' && f !== 'index.js')
    .sort();
  for (const file of files) {
    await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href);
  }
}

// ============================================================================
// Config
// ============================================================================

const ADMIN_URL = process.env.MULTI_PROC_ADMIN_URL
  ?? `postgres://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/postgres`;
const DB_NAME = `chat_app_multi_proc_${Math.random().toString(36).slice(2, 8)}`;
const DB_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${DB_NAME}`);
const PG_HOST = process.env.PGHOST ?? 'localhost';
const PG_PORT = Number(process.env.PGPORT ?? 5433);

// Workers bind on PORT=0 (OS-assigned ephemeral). The HTTP adapter logs
// `[http] listening on http://localhost:<bound-port>` once accept() is
// up; we parse that line to learn each worker's port. No fixed port pool,
// so concurrent test files don't collide.
const SIGNAL_CHANNEL = `chat_app_proc_${Math.random().toString(36).slice(2, 8)}`;

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const JUST_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'just');

// ============================================================================
// Postgres liveness probe (skip if docker isn't running)
// ============================================================================

async function checkPg(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host: PG_HOST, port: PG_PORT, timeout: 1500 });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error',   () => done(false));
    sock.once('timeout', () => done(false));
  });
}

const hasPg = await checkPg();

// ============================================================================
// Worker spawn + readiness
// ============================================================================

interface Worker {
  proc: ChildProcess
  port: number
  stop(): Promise<void>
}

async function startWorker(id: string): Promise<Worker> {
  // Spawn the actual dev entrypoint — `just dev` — in a real separate
  // Node process. PORT=0 → development.ts forwards it to httpEnv({ port: 0 })
  // → OS picks an ephemeral port. The HTTP adapter logs the *bound* port
  // in `[http] listening on http://localhost:<port>`; we parse it so the
  // test learns the chosen port without a fixed pool that collides with
  // sibling test files.
  const proc = spawn(
    JUST_BIN,
    ['dev'],
    {
      cwd: APP_DIR,
      env: {
        ...process.env,
        PORT: '0',
        DATABASE_URL: DB_URL,
        SIGNAL_CHANNEL,
        // Two `just dev` workers against the same project dir would
        // collide on the cluster unix socket (path hashed from cwd).
        // Skip it — these workers coordinate via pg, not the socket.
        JUSTSCALE_NO_SOCKET: '1',
        NODE_NO_WARNINGS: '1',
      },
      // Stdin ignored → the dev-shell boot sees no TTY and stays out of
      // the way. Stdout/stderr both piped so we can detect `[http] listening`.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let readyResolved = false;
  const ready = new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`worker ${id} did not start listening within 30s`)), 30_000);
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Pipe dev logs to the parent so boot errors aren't silent.
      process.stderr.write(`[${id}] ${text}`);
      const match = text.match(/listening on http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(t);
        readyResolved = true;
        resolve(Number(match[1]));
      }
    };
    proc.stdout!.on('data', onChunk);
    proc.stderr!.on('data', onChunk);
    // If the worker dies before we see the listening line, fail fast
    // instead of hanging on the ready promise.
    proc.once('exit', (code) => {
      clearTimeout(t);
      if (!readyResolved) reject(new Error(`worker ${id} exited early with code ${code}`));
    });
  });

  const port = await ready;

  // HTTP logs before the bind completes — give it a tick to be accept()-ready.
  await new Promise((r) => setTimeout(r, 200));

  return {
    proc,
    port,
    async stop() {
      if (proc.killed || proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      await Promise.race([
        once(proc, 'exit'),
        new Promise<void>((r) => setTimeout(r, 3_000)),
      ]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    },
  };
}

// ============================================================================
// HTTP + WS helpers
// ============================================================================

async function readJson<T>(res: Response, expectedStatus: number, label: string): Promise<T> {
  const text = await res.text();
  assert.strictEqual(res.status, expectedStatus, `${label} returned ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function register(port: number, email: string, password: string, name: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  const body = await readJson<{ token: string; user: { id: string } }>(res, 201, `register on :${port}`);
  return { token: body.token, userId: body.user.id };
}

async function createRoom(port: number, token: string, name: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/rooms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ name, visibility: 'public' }),
  });
  const body = await readJson<{ room: { id: string; name: string } }>(res, 201, `createRoom on :${port}`);
  return body.room;
}

async function joinRoom(port: number, token: string, roomId: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}` },
  });
  const text = await res.text();
  assert.strictEqual(res.status, 201, `joinRoom on :${port} returned ${res.status}: ${text}`);
}

interface WsHandle {
  socket: WebSocket
  messages: Array<{ type: string; data: unknown }>
  close(): void
}

async function openRoomWs(port: number, token: string, roomId: string): Promise<WsHandle> {
  const url = `ws://127.0.0.1:${port}/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(url);
  const messages: Array<{ type: string; data: unknown }> = [];
  socket.addEventListener('message', (ev) => {
    try { messages.push(JSON.parse(String(ev.data))); } catch { /* ignore non-JSON */ }
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ws open timeout on :${port}`)), 5_000);
    socket.addEventListener('open',  () => { clearTimeout(t); resolve(); }, { once: true });
    socket.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(`ws error on :${port}: ${String((e as ErrorEvent).message ?? e)}`)); }, { once: true });
  });
  return {
    socket,
    messages,
    close() { try { socket.close(); } catch { /* ignore */ } },
  };
}

async function waitForMessage(
  handle: WsHandle,
  predicate: (msg: { type: string; data: unknown }) => boolean,
  timeoutMs: number,
): Promise<{ type: string; data: unknown } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = handle.messages.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// ============================================================================
// Tests
// ============================================================================

describe('Chat-app cross-process e2e', { skip: !hasPg ? 'docker postgres not reachable' : false }, () => {
  let workerA: Worker;
  let workerB: Worker;

  before(async () => {
    // Create a scratch DB per run so parallel CI runs don't collide and
    // every run starts clean.
    const admin = postgres(ADMIN_URL, { max: 1 });
    try {
      await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
    } finally {
      await admin.end();
    }

    // Run migrations in-process so the workers boot against a ready schema.
    const env = createEnvironment<AppEnv>({
      name: 'chat-multi-proc-migrator',
      type: 'test',
      services: [HardcodedVault({ 'postgres/url': DB_URL })],
      providers: buildProviders([
        appEnv({ siteUrl: 'http://localhost:0', logLevel: 'error' }),
        httpEnv({ port: 0 }),
        postgresProcessEnv({ signalChannel: SIGNAL_CHANNEL }),
        postgresMigrationEnv(),
        postgresMigrationDevEnv(),
        postgresSecret('postgres/url'),
        userFlagsEnv({ autoVerify: true }),
      ]),
    });
    // Populate the migration registry from this app's ./migrations dir
    // by explicit path so we don't depend on process.cwd().
    await loadChatAppMigrations();

    const built = (await makeApp(env)).build();
    const app = built.compile();
    await app.ready;
    const runner = await app.container.resolve(MigrationRunnerService);
    const ran = await runner.migrate();
    assert.ok(ran.length > 0, `expected at least one migration to run; got: ${JSON.stringify(ran)}`);
    await built.stop();

    // Bring the two real workers up in parallel.
    [workerA, workerB] = await Promise.all([
      startWorker('A'),
      startWorker('B'),
    ]);
  });

  after(async () => {
    await workerA?.stop();
    await workerB?.stop();

    const admin = postgres(ADMIN_URL, { max: 1 });
    try {
      await admin.unsafe(`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid()
      `);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    } finally {
      await admin.end();
    }
  });

  it('cross-process observe: changeTopic on A triggers for-await on B (SSE spectate)', async () => {
    // Tests: "updating a model on process A, a for-await on the same model
    // on process B also triggers." The SSE controller's handler is literally
    //   for await (const msg of room.broadcast) { yield ... }
    // — so this exercises the observe surface end-to-end across processes.
    const stamp = Date.now();
    const portA = workerA.port;
    const portB = workerB.port;
    const owner = await register(portA, `spectator-owner-${stamp}@proc.test`, 'hunter22', 'Owner');
    const room = await createRoom(portA, owner.token, `spectate-room-${stamp}`);

    // Open the SSE stream on B. fetch() with AbortSignal is enough — no
    // dependency needed. We read line-by-line until we see the event we want.
    const ctrl = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${portB}/rooms/${room.id}/spectate`, {
      headers: { accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    assert.strictEqual(sseRes.status, 200, `SSE on :${portB} returned ${sseRes.status}`);
    assert.ok(sseRes.body, 'SSE response body missing');

    const events: Array<{ event: string; data: string }> = [];
    const readerDone = (async () => {
      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Parse standard SSE frames: `event: X\n` + `data: Y\n\n`
          let sep;
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const eventLine = frame.match(/^event:\s*(.*)$/m);
            const dataLine  = frame.match(/^data:\s*(.*)$/m);
            if (eventLine) events.push({ event: eventLine[1], data: dataLine?.[1] ?? '' });
          }
        }
      } catch { /* AbortError on close — expected */ }
    })();

    try {
      // Wait for the initial `connected` event so we know the LISTEN is
      // registered before we push an update.
      const connectedDeadline = Date.now() + 5_000;
      while (!events.some((e) => e.event === 'connected') && Date.now() < connectedDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(events.some((e) => e.event === 'connected'), `SSE on :${portB} never emitted 'connected'`);

      // Drive the update on A via HTTP.
      const newTopic = `topic @ ${stamp}`;
      const patch = await fetch(`http://127.0.0.1:${portA}/rooms/${room.id}/topic`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${owner.token}`,
        },
        body: JSON.stringify({ topic: newTopic }),
      });
      const patchText = await patch.text();
      assert.strictEqual(patch.status, 200, `PATCH topic on :${portA} returned ${patch.status}: ${patchText}`);

      // Wait for the SSE stream on B to see the topic_changed event.
      const deadline = Date.now() + 10_000;
      while (!events.some((e) => e.event === 'topic_changed' && e.data.includes(newTopic)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        events.some((e) => e.event === 'topic_changed' && e.data.includes(newTopic)),
        `B's SSE feed on :${portB} never saw topic_changed for the PATCH on :${portA}; got: ${JSON.stringify(events)}`,
      );
    } finally {
      ctrl.abort();
      await readerDone;
    }
  });

  it('cross-process chat: A ↔ B via pg LISTEN/NOTIFY + advisory locks', async () => {
    const stamp = Date.now();
    const portA = workerA.port;
    const portB = workerB.port;
    const alice = await register(portA, `alice-${stamp}@proc.test`, 'hunter22', 'Alice');
    const bob   = await register(portB, `bob-${stamp}@proc.test`,   'hunter22', 'Bob');

    const room = await createRoom(portA, alice.token, `proc-room-${stamp}`);
    await joinRoom(portB, bob.token, room.id);

    const bobWs   = await openRoomWs(portB, bob.token,   room.id);
    const aliceWs = await openRoomWs(portA, alice.token, room.id);

    try {
      // Give the member-subprocesses a beat to attach on both sides before
      // we start publishing. Without this, a post can race ahead of a
      // subscribe on the pg signal bus.
      await new Promise((r) => setTimeout(r, 500));

      // A → B
      const aToBPayload = `hello from A @ ${stamp}`;
      aliceWs.socket.send(JSON.stringify({ type: 'post', text: aToBPayload }));

      const onB = await waitForMessage(
        bobWs,
        (m) => m.type === 'message' && (m.data as { text?: string }).text === aToBPayload,
        10_000,
      );
      assert.ok(onB, `bob on :${portB} never received alice's message from :${portA}; messages: ${JSON.stringify(bobWs.messages)}`);

      // B → A (reverse direction on the same live sockets)
      const bToAPayload = `reply from B @ ${stamp}`;
      bobWs.socket.send(JSON.stringify({ type: 'post', text: bToAPayload }));

      const onA = await waitForMessage(
        aliceWs,
        (m) => m.type === 'message' && (m.data as { text?: string }).text === bToAPayload,
        10_000,
      );
      assert.ok(onA, `alice on :${portA} never received bob's message from :${portB}; messages: ${JSON.stringify(aliceWs.messages)}`);
    } finally {
      aliceWs.close();
      bobWs.close();
    }
  });
});
