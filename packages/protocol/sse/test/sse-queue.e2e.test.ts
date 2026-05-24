/**
 * E2E Test: SSE + Queue integration
 *
 * Tests the full flow:
 * 1. Create a Queue
 * 2. SSE handler streams from the Queue
 * 3. Push items to Queue while client is connected
 * 4. Client receives events in order
 * 5. Client disconnects → generator cleanup
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { createQueue } from '@justscale/core';
import { handleSSE } from '../src/handler.js';
import type { SSEEvent } from '../src/types.js';

describe('SSE + Queue E2E', () => {
  it('should stream Queue items as SSE events', async () => {
    const queue = createQueue<SSEEvent>();

    // SSE handler that drains the queue
    const server = http.createServer(async (req, res) => {
      await handleSSE(req, res, {
        route: {
          method: 'SSE',
          async *handler() {
            for await (const event of queue) {
              yield event;
            }
          },
        },
        params: {},
        deps: {},
      });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    try {
      // Push events before client connects
      queue.push({ event: 'order_created', data: { orderId: '123', status: 'pending' } });
      queue.push({ event: 'payment_confirmed', data: { orderId: '123', status: 'confirmed' } });

      // Connect SSE client
      const controller = new AbortController();
      const response = await fetch(`http://localhost:${port}/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get('content-type'), 'text/event-stream');

      // Push more events while client is connected
      setTimeout(() => {
        queue.push({ event: 'shipped', data: { orderId: '123', trackingNumber: '1Z999' } });
        // Close the queue to end the stream
        setTimeout(() => queue.close(), 50);
      }, 50);

      const text = await response.text();

      // Verify all events are in the response
      assert.ok(text.includes('event: order_created'), 'should contain order_created');
      assert.ok(text.includes('"status":"pending"'), 'should contain pending status');
      assert.ok(text.includes('event: payment_confirmed'), 'should contain payment_confirmed');
      assert.ok(text.includes('"status":"confirmed"'), 'should contain confirmed status');
      assert.ok(text.includes('event: shipped'), 'should contain shipped');
      assert.ok(text.includes('"trackingNumber":"1Z999"'), 'should contain tracking number');
    } finally {
      server.close();
    }
  });

  it('should handle client disconnect while queue is waiting', async () => {
    const queue = createQueue<SSEEvent>();
    let generatorDone = false;

    const server = http.createServer(async (req, res) => {
      await handleSSE(req, res, {
        route: {
          method: 'SSE',
          async *handler(ctx: any) {
            try {
              yield { event: 'connected', data: {} };

              // Use the aborted promise to detect disconnect and close the queue
              ctx.aborted.then(() => queue.close());

              for await (const event of queue) {
                yield event;
              }
            } finally {
              generatorDone = true;
            }
          },
        },
        params: {},
        deps: {},
      });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    try {
      const controller = new AbortController();

      const fetchPromise = fetch(`http://localhost:${port}/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });

      // Wait for connection to establish
      await new Promise(r => setTimeout(r, 100));

      // Disconnect
      controller.abort();
      try { await fetchPromise; } catch {
        /* expected — controller.abort() rejects the in-flight fetch */
      }

      // Wait for cleanup — queue.close() unblocks the generator,
      // which then hits the finally block
      for (let i = 0; i < 20 && !generatorDone; i++) {
        await new Promise(r => setTimeout(r, 50));
      }

      assert.ok(generatorDone, 'generator should have cleaned up on disconnect');
    } finally {
      queue.close();
      server.close();
    }
  });

  it('should stream from multiple queues', async () => {
    const orders = createQueue<SSEEvent>();
    const notifications = createQueue<SSEEvent>();

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');

      await handleSSE(req, res, {
        route: {
          method: 'SSE',
          async *handler() {
            const q = url.pathname === '/orders' ? orders : notifications;
            for await (const event of q) {
              yield event;
            }
          },
        },
        params: {},
        deps: {},
      });
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    try {
      // Push to different queues
      orders.push({ event: 'order', data: { id: 1 } });
      notifications.push({ event: 'notify', data: { msg: 'hello' } });

      // Close both
      setTimeout(() => { orders.close(); notifications.close(); }, 50);

      // Connect to orders
      const orderRes = await fetch(`http://localhost:${port}/orders`, {
        headers: { Accept: 'text/event-stream' },
      });
      const orderText = await orderRes.text();
      assert.ok(orderText.includes('event: order'), 'orders stream should have order event');
      assert.ok(!orderText.includes('event: notify'), 'orders stream should NOT have notification');

      // Connect to notifications
      const notifRes = await fetch(`http://localhost:${port}/notifications`, {
        headers: { Accept: 'text/event-stream' },
      });
      const notifText = await notifRes.text();
      assert.ok(notifText.includes('event: notify'), 'notifications stream should have notify event');
      assert.ok(!notifText.includes('event: order'), 'notifications stream should NOT have order');
    } finally {
      server.close();
    }
  });
});
