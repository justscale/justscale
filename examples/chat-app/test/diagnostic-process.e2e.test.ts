/**
 * Diagnostic: does ensureProcess() actually start the room process?
 *
 * Single-instance. Create a room, call ensureProcess, then:
 *   1. Assert a row lands in process_executions (process registered)
 *   2. Fire messagePosted via the service
 *   3. Wait briefly, then assert the Message row landed
 *
 * If step 1 passes but step 3 fails, the process is registered but its
 * handler isn't running (signal not delivered, handler crashed silently,
 * or compiler didn't transform createProcess). If step 1 fails, the
 * process never started.
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
  AbstractPostgresClient,
} from '@justscale/postgres';
import { ModelRepository } from '@justscale/core/models';
import { UserService } from '@justscale/auth';

import { appEnv, userFlagsEnv, type AppEnv } from '../src/env-contract.js';
import makeApp from '../src/app.js';
import { Message } from '../src/domains/chat/message.model.js';

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
import { ChatService } from '../src/domains/chat/chat.service.js';

const ADMIN_URL = process.env.PROC_DIAG_ADMIN_URL
  ?? `postgres://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/postgres`;
const DB_NAME = process.env.PROC_TEST_DB_URL
  ? undefined
  : `chat_proc_${Math.random().toString(36).slice(2, 8)}`;
const DB_URL = process.env.PROC_TEST_DB_URL
  ?? ADMIN_URL.replace(/\/[^/]+$/, `/${DB_NAME}`);
const SIGNAL_CHANNEL = DB_NAME ?? 'proc_diag_override';

function makeEnv() {
  return createEnvironment<AppEnv>({
    name: 'chat-proc-diag',
    type: 'test',
    services: [HardcodedVault({ 'postgres/url': DB_URL })],
    providers: buildProviders([
      // port:0 → OS-assigned ephemeral port. This test drives services
      // through the container, never via HTTP — the bind exists only because
      // the chat app registers HTTP routes. Avoid fixed-port collisions.
      appEnv({ siteUrl: 'http://localhost', logLevel: 'error' }),
      httpEnv({ port: 0 }),
      postgresProcessEnv({ signalChannel: SIGNAL_CHANNEL }),
      postgresMigrationEnv(),
      postgresMigrationDevEnv(),
      postgresSecret('postgres/url'),
      userFlagsEnv({ autoVerify: true }),
    ]),
  });
}

describe('Diagnostic: room process lifecycle', async () => {
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

    const builder = await makeApp(makeEnv());
    ctx.built = builder.build();
    ctx.app = ctx.built.compile();
    await ctx.app.ready;

    await loadChatAppMigrations();
    const runner = await ctx.app.container.resolve(MigrationRunnerService);
    await runner.migrate();

    ctx.chat = await ctx.app.container.resolve(ChatService);
    ctx.users = await ctx.app.container.resolve(UserService);
    ctx.messages = await ctx.app.container.resolve(ModelRepository.of(Message));
    ctx.pgClient = await ctx.app.container.resolve(AbstractPostgresClient);
  });

  after(async () => {
    await ctx.built?.stop().catch(() => {});

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

  it('ensureProcess registers a process_executions row', async () => {
    const { chat, users, pgClient } = ctx as {
      chat: ChatService;
      users: UserService;
      pgClient: AbstractPostgresClient;
    };
    const suffix = Date.now();
    const alice = await users.register(`alice-proc-${suffix}@t.test`, 'hunter22', 'Alice');
    const room = await chat.createRoom(alice, `proc-room-${suffix}`, 'public');

    await chat.ensureProcess(room);

    // Give the runtime a beat
    await new Promise(r => setTimeout(r, 500));

    // Path /chatroom/:room is stored as process_id 'chatroom__room'
    // after the runtime replaces '/'+':' with '__'.
    const rows = await pgClient.sql`
      SELECT process_id, status, pc FROM process_executions
      WHERE process_id LIKE ${'chatroom__%'}
    ` as unknown as Array<{ process_id: string; status: string; pc: number }>;

    assert.ok(rows.length > 0, `expected at least one chat process row; got ${JSON.stringify(rows)}`);
    assert.ok(
      rows.some(r => r.status === 'suspended'),
      `expected a suspended row (waiting on signal); got ${JSON.stringify(rows)}`,
    );
    void room;
  });

  it('posting a message eventually persists a Message row', async () => {
    const { chat, users, messages } = ctx as {
      chat: ChatService;
      users: UserService;
      messages: ModelRepository<Message>;
    };
    const suffix = Date.now();
    const alice = await users.register(`alice-post-${suffix}@t.test`, 'hunter22', 'Alice');
    const room = await chat.createRoom(alice, `post-room-${suffix}`, 'public');

    await chat.ensureProcess(room);
    await new Promise(r => setTimeout(r, 200));

    await chat.post(room, alice, `hello ${suffix}`);

    // Poll for up to 3s
    const deadline = Date.now() + 3000;
    let rows: unknown[] = [];
    while (Date.now() < deadline) {
      rows = await messages.find({ where: Message.fields.room.eq(room) });
      if (rows.length > 0) break;
      await new Promise(r => setTimeout(r, 100));
    }

    assert.ok(rows.length > 0, `expected Message row to be inserted by the room process; got ${rows.length}`);
  });
});
