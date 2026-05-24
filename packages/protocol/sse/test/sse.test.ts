import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { formatSSEEvent, formatHeartbeat } from '../src/format.js';
import { handleSSE } from '../src/handler.js';
import { SSE } from '../src/factory.js';
import { defineModel, field, isReference, applyTypesConfig } from '@justscale/core/models';

describe('SSE Format', () => {
  it('should format a basic event', () => {
    const result = formatSSEEvent({ data: { hello: 'world' } });
    assert.strictEqual(result, 'data: {"hello":"world"}\n\n');
  });

  it('should include event type', () => {
    const result = formatSSEEvent({ event: 'update', data: 'test' });
    assert.strictEqual(result, 'event: update\ndata: test\n\n');
  });

  it('should include event id', () => {
    const result = formatSSEEvent({ id: '42', data: {} });
    assert.strictEqual(result, 'id: 42\ndata: {}\n\n');
  });

  it('should include retry', () => {
    const result = formatSSEEvent({ retry: 3000, data: 'x' });
    assert.strictEqual(result, 'retry: 3000\ndata: x\n\n');
  });

  it('should handle multi-line data', () => {
    const result = formatSSEEvent({ data: 'line1\nline2\nline3' });
    assert.strictEqual(result, 'data: line1\ndata: line2\ndata: line3\n\n');
  });

  it('should format all fields together', () => {
    const result = formatSSEEvent({ id: '1', event: 'msg', retry: 5000, data: { ok: true } });
    assert.strictEqual(result, 'id: 1\nevent: msg\nretry: 5000\ndata: {"ok":true}\n\n');
  });

  it('should format heartbeat', () => {
    assert.strictEqual(formatHeartbeat(), ': heartbeat\n\n');
  });
});

describe('SSE Handler', () => {
  it('should stream events over HTTP', async () => {
    // Create a raw HTTP server that calls handleSSE directly
    const server = http.createServer(async (req, res) => {
      const route = {
        method: 'SSE',
        handler: async function* () {
          yield { event: 'hello', data: { message: 'connected' } };
          yield { event: 'update', data: { count: 1 } };
          yield { event: 'update', data: { count: 2 } };
        },
      };

      await handleSSE(req, res, {
        route,
        params: {},
        deps: {},
      });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        resolve((server.address() as any).port);
      });
    });

    try {
      const response = await fetch(`http://localhost:${port}/events`, {
        headers: { Accept: 'text/event-stream' },
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get('content-type'), 'text/event-stream');

      const text = await response.text();

      assert.ok(text.includes('event: hello'), `should contain hello event, got: ${text}`);
      assert.ok(text.includes('"message":"connected"'), 'should contain connected data');
      assert.ok(text.includes('event: update'), 'should contain update event');
      assert.ok(text.includes('"count":1'), 'should contain count 1');
      assert.ok(text.includes('"count":2'), 'should contain count 2');
    } finally {
      server.close();
    }
  });

  it('should pass Last-Event-ID to handler context', async () => {
    let receivedLastEventId: string | undefined;

    const server = http.createServer(async (req, res) => {
      const route = {
        method: 'SSE',
        handler: async function* (ctx: any) {
          receivedLastEventId = ctx.lastEventId;
          yield { data: 'done' };
        },
      };

      await handleSSE(req, res, { route, params: {}, deps: {} });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    try {
      await fetch(`http://localhost:${port}/events`, {
        headers: {
          Accept: 'text/event-stream',
          'Last-Event-ID': '42',
        },
      });

      assert.strictEqual(receivedLastEventId, '42');
    } finally {
      server.close();
    }
  });

  it('should clean up on client disconnect', async () => {
    let generatorCleaned = false;

    const server = http.createServer(async (req, res) => {
      const route = {
        method: 'SSE',
        handler: async function* () {
          try {
            while (true) {
              yield { data: 'tick' };
              await new Promise(r => setTimeout(r, 50));
            }
          } finally {
            generatorCleaned = true;
          }
        },
      };

      await handleSSE(req, res, { route, params: {}, deps: {} });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    try {
      const controller = new AbortController();

      // Start SSE connection
      const fetchPromise = fetch(`http://localhost:${port}/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });

      // Wait a bit, then abort
      await new Promise(r => setTimeout(r, 100));
      controller.abort();

      try { await fetchPromise; } catch {
        /* expected — controller.abort() rejects the in-flight fetch */
      }

      // Give the server time to clean up
      await new Promise(r => setTimeout(r, 100));

      assert.ok(generatorCleaned, 'generator should have been cleaned up on disconnect');
    } finally {
      server.close();
    }
  });

  it('should apply types config to params when route has types', async () => {
    class Ticket extends defineModel({
      fields: { subject: field.string() },
    }) {}

    let capturedParams: any = null;

    const server = http.createServer(async (req, res) => {
      const route = SSE('/:ticket/events')
        .types({ Ticket })
        .handle(async function* ({ params }) {
          capturedParams = params;
          yield { data: 'done' };
        });

      await handleSSE(req, res, {
        route,
        params: { ticket: 'ticket-abc' },
        deps: {},
      });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    try {
      await fetch(`http://localhost:${port}/ticket-abc/events`, {
        headers: { Accept: 'text/event-stream' },
      });

      assert.ok(isReference(capturedParams.ticket), 'ticket param should be a Reference');
      assert.strictEqual(capturedParams.ticket.identifier, 'ticket-abc');
    } finally {
      server.close();
    }
  });
});

describe('SSE Builder', () => {
  it('SSE() creates builder with SSE method', () => {
    const route = SSE('/events')
      .handle(async function* () {
        yield { data: 'hello' };
      });

    assert.strictEqual(route.method, 'SSE');
    assert.strictEqual(route.path, '/events');
  });

  it('passes params from matched route to handler', async () => {
    let capturedParams: any = null;

    const server = http.createServer(async (req, res) => {
      const route = SSE('/:roomId/events')
        .handle(async function* ({ params }) {
          capturedParams = params;
          yield { data: 'done' };
        });

      await handleSSE(req, res, {
        route,
        params: { roomId: 'room-42' },
        deps: {},
      });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    try {
      await fetch(`http://localhost:${port}/room-42/events`, {
        headers: { Accept: 'text/event-stream' },
      });

      assert.strictEqual(capturedParams.roomId, 'room-42');
    } finally {
      server.close();
    }
  });

  it('.types() stores types on route def', () => {
    class Product extends defineModel({
      fields: { name: field.string() },
    }) {}

    const route = SSE('/:product/events')
      .types({ Product })
      .handle(async function* () {
        yield { data: 'ok' };
      });

    assert.ok((route as any).types);
    assert.strictEqual((route as any).types.Product, Product);
  });

  it('.types() transforms params to References at runtime', async () => {
    class Product extends defineModel({
      fields: { name: field.string() },
    }) {}

    let capturedParams: any = null;

    const route = SSE('/:product/events')
      .types({ Product })
      .handle(async function* ({ params }) {
        capturedParams = params;
        yield { data: 'done' };
      });

    // Simulate what handleSSE does: applyTypesConfig
    const rawParams = { product: 'prod-123' };
    const typedParams = applyTypesConfig(rawParams, (route as any).types);

    assert.ok(isReference(typedParams.product));
    assert.strictEqual((typedParams.product as any).identifier, 'prod-123');
  });

  it('compile-time: params are inferred from path string', () => {
    // If types are wrong, this file won't compile.
    SSE('/:ticketId/events')
      .handle(async function* ({ params }) {
        const _id: string = params.ticketId;
        void _id;
        yield { data: 'ok' };
      });
  });

  it('compile-time: params.ticket is Reference after .types()', () => {
    class Ticket extends defineModel({
      fields: { subject: field.string() },
    }) {}

    SSE('/:ticket/events')
      .types({ Ticket })
      .handle(async function* ({ params }) {
        const _id: string = params.ticket.identifier;
        void _id;
        yield { data: 'ok' };
      });
  });

  it('supports .use() and .guard() chaining', () => {
    const route = SSE('/events')
      .use(() => ({ user: { id: '1' } }))
      .guard(() => undefined)
      .handle(async function* () {
        yield { data: 'ok' };
      });

    assert.strictEqual(route.method, 'SSE');
    assert.strictEqual(route.steps.length, 2);
    assert.strictEqual(route.steps[0].type, 'use');
    assert.strictEqual(route.steps[1].type, 'guard');
  });
});
