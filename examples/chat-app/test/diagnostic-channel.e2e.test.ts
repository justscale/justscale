/**
 * Diagnostic: does the PostgresChannelFeature actually forward
 * LISTEN/NOTIFY across two JustScale instances in one process?
 *
 * Cuts signals + process out of the path — just pure channel
 * pub/sub. If this FAILS, the bug is in the pg channel backend
 * (or in how our two in-process instances configure it). If it
 * PASSES, the bug in the chat flow is higher up (signal routing,
 * process lifecycle, or timing).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
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
import { ModelRepository } from '@justscale/core/models';
import { User } from '@justscale/auth';

import { appEnv, userFlagsEnv, type AppEnv } from '../src/env-contract.js';
import makeApp from '../src/app.js';
import { ChatRoom } from '../src/domains/chat/chat-room.model.js';

// Load migrations explicitly by absolute path. Cannot rely on
// '@justscale/postgres/virtual/migrations' here - that resolves from cwd,
// which is the repo root under `pnpm test`, not the chat-app dir.
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

const ADMIN_URL = process.env.DIAG_CHANNEL_ADMIN_URL
  ?? `postgres://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/postgres`;
const DB_NAME = process.env.DIAG_TEST_DB_URL
  ? undefined
  : `chat_diag_${Math.random().toString(36).slice(2, 8)}`;
const DB_URL = process.env.DIAG_TEST_DB_URL
  ?? ADMIN_URL.replace(/\/[^/]+$/, `/${DB_NAME}`);
const SIGNAL_CHANNEL = DB_NAME ?? 'diag_channel_override';

function makeEnv(instanceId: number) {
  return createEnvironment<AppEnv>({
    name: `chat-diag-${instanceId}`,
    type: 'test',
    services: [HardcodedVault({ 'postgres/url': DB_URL })],
    providers: buildProviders([
      // port:0 → OS-assigned ephemeral port. No fetch/WS happens in this
      // test (services are resolved from the container directly), so the
      // exact port doesn't matter — just don't collide with sibling tests.
      appEnv({ siteUrl: `http://localhost`, logLevel: 'error' }),
      httpEnv({ port: 0 }),
      postgresProcessEnv({ signalChannel: SIGNAL_CHANNEL }),
      postgresMigrationEnv(),
      postgresMigrationDevEnv(),
      postgresSecret('postgres/url'),
      userFlagsEnv({ autoVerify: true }),
    ]),
  });
}

describe('Diagnostic: pg channel pub/sub across instances', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: Record<string, any> = {};

  before(async () => {
    if (DB_NAME) {
      const admin = postgres(ADMIN_URL, { max: 1 });
      try {
        await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
      } finally {
        await admin.end();
      }
    }

    const builderA = await makeApp(makeEnv(1));
    const builderB = await makeApp(makeEnv(2));
    ctx.builtA = builderA.build();
    ctx.builtB = builderB.build();
    const appA = ctx.builtA.compile();
    const appB = ctx.builtB.compile();
    await Promise.all([appA.ready, appB.ready]);

    await loadChatAppMigrations();
    const migrationRunner = await appA.container.resolve(MigrationRunnerService);
    await migrationRunner.migrate();

    ctx.roomsA = await appA.container.resolve(ModelRepository.of(ChatRoom));
    ctx.roomsB = await appB.container.resolve(ModelRepository.of(ChatRoom));
    ctx.usersA = await appA.container.resolve(ModelRepository.of(User));
    void appB;
  });

  after(async () => {
    await ctx.builtA?.stop().catch(() => {});
    await ctx.builtB?.stop().catch(() => {});

    if (DB_NAME) {
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
    }
  });

  it('publish on A, subscribe on B → receive', async () => {
    const { roomsA, roomsB, usersA } = ctx as {
      roomsA: ModelRepository<ChatRoom>;
      roomsB: ModelRepository<ChatRoom>;
      usersA: ModelRepository<User>;
    };
    const suffix = Date.now();
    const alice = await usersA.insert({
      email: `alice-diag-${suffix}@t.test`,
      passwordHash: 'x',
      name: 'Alice',
      twoFactorEnabled: false,
    });
    const room = await roomsA.insert({
      name: `diag-${suffix}`,
      visibility: 'public',
      createdBy: alice,
    });

    // Resolve the SAME room via B — different Persistent instance, but
    // the broadcast stream field should subscribe to the same pg channel
    // because the channel key is derived from the entity identifier.
    const roomOnB = (await roomsB.get(ChatRoom.ref(room)))!;
    assert.ok(roomOnB);

    const received: Array<{ type: string; data: unknown }> = [];
    const deadline = Date.now() + 3000;
    const sub = (async () => {
      for await (const msg of roomOnB.broadcast) {
        received.push(msg as { type: string; data: unknown });
        return;
      }
    })();

    // Give the LISTEN a moment to register in the driver
    await new Promise(r => setTimeout(r, 300));

    // Publish from instance A's view of the same room
    const roomOnA = (await roomsA.get(ChatRoom.ref(room)))!;
    roomOnA.broadcast.publish({ type: 'diag_ping', data: { at: suffix } } as never);

    await Promise.race([sub, new Promise(r => setTimeout(r, 3000))]);

    assert.ok(
      received.length > 0,
      `expected B to receive A's publish within 3s; got: ${JSON.stringify(received)}`,
    );
    assert.strictEqual((received[0] as { type: string }).type, 'diag_ping');
    void deadline;
  });
});
