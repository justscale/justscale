/**
 * THE headline test.
 *
 * Two JustScale app instances share one real Postgres database. A
 * message posted on instance A reaches a broadcast subscriber on
 * instance B via LISTEN/NOTIFY. The room process is held by whichever
 * instance won the advisory-lock race; the other instance reaches it
 * via signals. This is the whole pitch of the framework in one test.
 *
 * Requires docker postgres from the repo root (`docker compose up -d`).
 * A fresh database is created inline in `before` and dropped in `after`.
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
import { User, UserService } from '@justscale/auth';

import { appEnv, userFlagsEnv, type AppEnv } from '../src/env-contract.js';
import makeApp from '../src/app.js';
import { ChatRoom } from '../src/domains/chat/chat-room.model.js';
import { ChatService } from '../src/domains/chat/chat.service.js';

// Load migrations explicitly by absolute path (cwd at repo root, not chat-app dir).
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

const ADMIN_URL = process.env.MULTI_ADMIN_URL
  ?? `postgres://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/postgres`;
const DB_NAME = process.env.MULTI_TEST_DB_URL
  ? undefined
  : `chat_multi_${Math.random().toString(36).slice(2, 8)}`;
const DB_URL = process.env.MULTI_TEST_DB_URL
  ?? ADMIN_URL.replace(/\/[^/]+$/, `/${DB_NAME}`);
const SIGNAL_CHANNEL = DB_NAME ?? 'multi_instance_override';

function makeEnv(instanceId: number) {
  return createEnvironment<AppEnv>({
    name: `chat-multi-${instanceId}`,
    type: 'test',
    services: [HardcodedVault({ 'postgres/url': DB_URL })],
    providers: buildProviders([
      // port:0 → OS-assigned ephemeral port per instance. The test exercises
      // cross-instance behaviour through services + LISTEN/NOTIFY, never via
      // HTTP, so the actual port is irrelevant — but two fixed ports would
      // collide with sibling parallel tests in the node:test pool.
      appEnv({ siteUrl: `http://localhost`, logLevel: 'error' }),
      httpEnv({ port: 0 }),
      // Both instances SHARE the signal channel so NOTIFY on one side
      // wakes subscribers on the other. Advisory locks then pick who
      // actually runs each process. That's the whole trick.
      postgresProcessEnv({ signalChannel: SIGNAL_CHANNEL }),
      postgresMigrationEnv(),
      postgresMigrationDevEnv(),
      postgresSecret('postgres/url'),
      userFlagsEnv({ autoVerify: true }),
    ]),
  });
}

describe('Multi-instance chat', async () => {
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

    // Two separate apps in one process — simulates two pods hitting the
    // same Postgres. They build separately, compile separately, resolve
    // services separately. Only the database is shared.
    const builderA = await makeApp(makeEnv(1));
    const builderB = await makeApp(makeEnv(2));
    ctx.builtA = builderA.build();
    ctx.builtB = builderB.build();
    const appA = ctx.builtA.compile();
    const appB = ctx.builtB.compile();
    await Promise.all([appA.ready, appB.ready]);

    // Schema is not auto-created; the migration feature only provides CLI
    // commands. Run migrations inline on instance A (shared DB → both see
    // the tables).
    await loadChatAppMigrations();
    const migrationRunner = await appA.container.resolve(MigrationRunnerService);
    await migrationRunner.migrate();

    // Instance A's services
    ctx.chatA    = await appA.container.resolve(ChatService);
    ctx.usersA   = await appA.container.resolve(UserService);
    ctx.userRepoA = await appA.container.resolve(ModelRepository.of(User));

    // Instance B's services
    ctx.chatB  = await appB.container.resolve(ChatService);
    ctx.roomsB = await appB.container.resolve(ModelRepository.of(ChatRoom));
  });

  after(async () => {
    // Stop both app instances first so their pg connections are closed before
    // we drop the database. Without this ordering, in-flight connection writes
    // fire CONNECTION_CLOSED errors asynchronously after the test ends, which
    // node:test treats as an unhandledRejection and fails the suite.
    await ctx.builtA?.stop().catch(() => {});
    await ctx.builtB?.stop().catch(() => {});

    // Brief settle window for any background pg listener teardown.
    await new Promise((r) => setTimeout(r, 200));

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

  it('shared storage: a room created on A is visible from B', async () => {
    const { chatA, chatB, usersA } = ctx as {
      chatA: ChatService;
      chatB: ChatService;
      usersA: UserService;
    };

    const alice = await usersA.register(`alice-@multi.test`, 'hunter22', 'Alice');
    const room = await chatA.createRoom(alice, `multi-room-`, 'public');
    assert.strictEqual(room.name, `multi-room-`);

    const fromB = await chatB.listRooms();
    assert.ok(
      fromB.some(r => r.name === `multi-room-`),
      'instance B should see the room instance A created',
    );
  });

  it('broadcast bridges: a message posted via A reaches a subscriber on B', async () => {
    const { chatA, chatB, userRepoA, roomsB } = ctx as {
      chatA: ChatService;
      chatB: ChatService;
      userRepoA: ModelRepository<User>;
      roomsB: ModelRepository<ChatRoom>;
    };

    const rooms = await chatB.listRooms();
    const target = rooms.find(r => r.name === `multi-room-`);
    assert.ok(target, 'room must exist');

    // Pick alice back up on A (she owns the room)
    const alice = await userRepoA.findOne(User.fields.email.eq(`alice-@multi.test`));
    assert.ok(alice);

    // Ensure the room process is running -- whichever instance grabs the
    // advisory lock first wins. Does not matter which; B can still
    // subscribe and A can still post.
    await chatA.ensureProcess(target!);

    // Subscribe to the room's broadcast on instance B. This uses
    // Postgres LISTEN/NOTIFY under the hood -- every instance listening
    // on the channel sees every publish.
    const received: Array<{ type: string; data: unknown }> = [];
    const roomHandleOnB = (await roomsB.get(target!))!;

    const deadline = Date.now() + 5000;
    const sub = (async () => {
      for await (const msg of roomHandleOnB.broadcast) {
        received.push(msg as any);
        if (received.some(m => m.type === 'message')) return;
        if (Date.now() > deadline) return;
      }
    })();

    // Tiny delay so the LISTEN is definitely registered before the publish
    await new Promise(r => setTimeout(r, 250));

    // Post on A -- service fires messagePosted; whichever instance's
    // room process holds the advisory lock picks it up, inserts the
    // Message, and publishes on broadcast.
    await chatA.post(target!, alice, `hello from A @ `);

    await Promise.race([sub, new Promise(r => setTimeout(r, 5000))]);

    assert.ok(
      received.some(m => m.type === 'message' && (m.data as { text?: string }).text === `hello from A @ `),
      `expected a 'message' event on B with the text we posted on A; got: ${JSON.stringify(received)}`,
    );
    void deadline;
  });
});
