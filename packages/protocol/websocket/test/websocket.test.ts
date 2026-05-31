import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import WebSocket from 'ws';
import { Container } from '@justscale/core/di';
import JustScale, { createController } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import { defaultHttpConfig } from '@justscale/http/testing';
import { createServer } from 'node:http';
import { Ws, createWsHandler, MESSAGE_SCHEMA } from '../src/index.js';

describe('WebSocket Route Factory', () => {
  it('should create a controller with Ws routes', () => {
    const controller = createController('/chat', {
      inject: {},
      routes: () => ({
        room: Ws('/room/:roomId').handle(() => {}),
      }),
    });

    assert.strictEqual(controller.prefix, '/chat');
    assert.ok(controller.factory);
  });

  it('should compile Ws route paths correctly', async () => {
    const controller = createController('/chat', {
      inject: {},
      routes: () => ({
        room: Ws('/room/:roomId').handle(() => {}),
        user: Ws('/user/:userId/messages').handle(() => {}),
      }),
    });

    const container = new Container();
    container.register(controller);
    const instance = await container.resolve(controller);

    assert.strictEqual(instance.routes.length, 2);
    assert.strictEqual(instance.routes[0].method, 'WS');
    assert.strictEqual(instance.routes[1].method, 'WS');
  });

  it('should attach message schema to route', async () => {
    const MessageSchema = z.object({ type: z.string() });

    const controller = createController('/chat', {
      inject: {},
      routes: () => ({
        room: Ws('/room').message(MessageSchema).handle(() => {}),
      }),
    });

    const container = new Container();
    container.register(controller);
    const instance = await container.resolve(controller);

    assert.ok((instance.routes[0] as any)[MESSAGE_SCHEMA]);
  });
});

describe('WebSocket Server Integration', () => {
  async function createTestEnv(
    routeConfig: any
  ) {
    const controller = createController('/test', routeConfig);
    const app = JustScale().add(defaultHttpConfig).add(InMemoryLockFeature).add(InMemoryProcessFeature).add(controller as any).build().compile();
    const wsHandler = createWsHandler(app);
    const server = createServer((_, res) => {
      res.writeHead(404);
      res.end();
    });

    server.on('upgrade', (req, socket, head) => {
      wsHandler.handleUpgrade(req, socket, head);
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(p);
      });
    });

    const cleanup = async () => {
      wsHandler.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    };

    return { port, cleanup };
  }

  it('should echo messages', async () => {
    const { port, cleanup } = await createTestEnv({
      inject: {},
      routes: () => ({
        route: Ws('/route').handle(async ({ messages, send }) => {
          const iterator = messages[Symbol.asyncIterator]();
          const result = await iterator.next();
          if (!result.done) {
            send({ echo: result.value });
          }
        }),
      }),
    });

    try {
      const ws = new WebSocket(`ws://localhost:${port}/test/route`);

      await new Promise<void>((res, rej) => {
        ws.once('open', res);
        ws.once('error', rej);
      });

      const msgPromise = new Promise<any>((res) => {
        ws.once('message', (d) => res(JSON.parse(d.toString())));
      });

      ws.send(JSON.stringify({ hello: 'world' }));

      const result = await msgPromise;
      assert.deepStrictEqual(result, { echo: { hello: 'world' } });

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await cleanup();
    }
  });

  it('should extract params', async () => {
    const { port, cleanup } = await createTestEnv({
      inject: {},
      routes: () => ({
        room: Ws('/room/:roomId').handle(async ({ send, params }) => {
          send({ joined: params.roomId });
        }),
      }),
    });

    try {
      const ws = new WebSocket(`ws://localhost:${port}/test/room/abc123`);

      // Register message handler BEFORE waiting for open to avoid race
      const msgPromise = new Promise<any>((res) => {
        ws.once('message', (d) => res(JSON.parse(d.toString())));
      });

      await new Promise<void>((res, rej) => {
        ws.once('open', res);
        ws.once('error', rej);
      });

      const result = await msgPromise;
      assert.deepStrictEqual(result, { joined: 'abc123' });

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await cleanup();
    }
  });

  it('should validate messages', async () => {
    const { port, cleanup } = await createTestEnv({
      inject: {},
      routes: () => ({
        route: Ws('/route')
          .message(z.object({ type: z.enum(['ping', 'msg']) }))
          .handle(async ({ messages, send }) => {
            const iterator = messages[Symbol.asyncIterator]();
            for (let i = 0; i < 5; i++) {
              const result = await Promise.race([
                iterator.next(),
                new Promise<{ done: true; value: undefined }>((r) =>
                  setTimeout(() => r({ done: true, value: undefined }), 200)
                ),
              ]);
              if (result.done) break;
              send({ type: result.value.type });
            }
          }),
      }),
    });

    try {
      const ws = new WebSocket(`ws://localhost:${port}/test/route`);
      await new Promise<void>((res, rej) => {
        ws.once('open', res);
        ws.once('error', rej);
      });

      const messages: any[] = [];
      ws.on('message', (d) => messages.push(JSON.parse(d.toString())));

      ws.send(JSON.stringify({ type: 'ping' }));
      ws.send(JSON.stringify({ invalid: true }));
      ws.send(JSON.stringify({ type: 'msg' }));

      await new Promise((r) => setTimeout(r, 150));

      assert.strictEqual(messages.length, 2);
      ws.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await cleanup();
    }
  });

  it('should reject unauthorized before completing handshake', async () => {
    const { port, cleanup } = await createTestEnv({
      inject: {},
      routes: () => ({
        route: Ws('/route')
          .guard((ctx: any) => ctx.headers['x-auth'] === 'secret')
          .handle(async () => {}),
      }),
    });

    try {
      const ws = new WebSocket(`ws://localhost:${port}/test/route`);

      // Guard runs pre-upgrade: server writes HTTP 401 and destroys the socket,
      // so the client never gets a WebSocket close frame — it gets an error.
      await new Promise<void>((res, rej) => {
        ws.on('error', () => res());
        ws.on('unexpected-response', (_req, response) => {
          assert.strictEqual(response.statusCode, 401);
          ws.terminate();
          res();
        });
        // Should not open successfully
        ws.on('open', () => rej(new Error('Connection should have been rejected')));
      });
    } finally {
      await cleanup();
    }
  });

  it('should propagate use() enrichments to handler after pre-upgrade check', async () => {
    const { port, cleanup } = await createTestEnv({
      inject: {},
      routes: () => ({
        route: Ws('/route')
          .use((ctx: any) => ({ user: ctx.headers['x-user'] ?? 'anonymous' }))
          .handle(async ({ send, ...ctx }: any) => {
            send({ user: ctx.user });
          }),
      }),
    });

    try {
      const ws = new WebSocket(`ws://localhost:${port}/test/route`, {
        headers: { 'x-user': 'alice' },
      });

      const msgPromise = new Promise<any>((res) => {
        ws.once('message', (d) => res(JSON.parse(d.toString())));
      });

      await new Promise<void>((res, rej) => {
        ws.once('open', res);
        ws.once('error', rej);
      });

      const result = await msgPromise;
      assert.deepStrictEqual(result, { user: 'alice' });
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await cleanup();
    }
  });

  it('should allow authorized', async () => {
    const { port, cleanup } = await createTestEnv({
      inject: {},
      routes: () => ({
        route: Ws('/route')
          .guard((ctx: any) => ctx.headers['x-auth'] === 'secret')
          .handle(async ({ send }) => {
            send({ ok: true });
          }),
      }),
    });

    try {
      const ws = new WebSocket(`ws://localhost:${port}/test/route`, {
        headers: { 'x-auth': 'secret' },
      });

      // Register message handler BEFORE waiting for open to avoid race
      const msgPromise = new Promise<any>((res) => {
        ws.once('message', (d) => res(JSON.parse(d.toString())));
      });

      await new Promise<void>((res, rej) => {
        ws.once('open', res);
        ws.once('error', rej);
      });

      const result = await msgPromise;
      assert.deepStrictEqual(result, { ok: true });
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await cleanup();
    }
  });
});
