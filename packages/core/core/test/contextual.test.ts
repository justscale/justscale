/**
 * Unit tests for Contextual Controllers
 *
 * Tests the contextual controller feature which enables programmatic invocation
 * of controllers with caller-provided context. This is ideal for WebSocket,
 * event-driven, and similar scenarios.
 *
 * Test Coverage:
 * - Controller creation with createContextualController<T>()
 * - Session management (creation, disposal, using statement)
 * - Session.invoke() returning ProcedureRequest
 * - ProcedureRequest lifecycle (join, subscribe, cancel, status)
 * - Path parameter extraction
 * - Middleware execution and context extension
 * - Guard evaluation and GuardDeniedError
 * - Body validation with Zod schemas
 * - Timeout handling and TimeoutError
 * - Generator handlers for streaming
 * - Session.run() with rawMessages() for WebSocket-like scenarios
 * - Custom parse/serialize options
 * - onDispose callbacks in LIFO order
 * - Automatic cancellation of pending requests on disposal
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { Container } from '../src/core/service.js';
import { createController, createContextualController } from '../src/core/controller.js';
import { Procedure } from '../src/core/controller.procedure.js';
import {
  ProcedureNotFoundError,
  GuardDeniedError,
  TimeoutError,
} from '../src/core/controller.contextual.js';
import type {
  RawMessageSource,
  Session,
  ProcedureRequest,
} from '../src/core/controller.contextual.js';

// ============================================================================
// Test Helpers
// ============================================================================

interface TestSession {
  userId: string;
  ws?: RawMessageSource;
}

class TestService {
  greet(name: string) {
    return `Hello, ${name}!`;
  }
}

/**
 * Mock WebSocket-like interface for testing run()
 */
class MockWebSocket implements RawMessageSource {
  private messages: Array<string | Buffer> = [];
  private messageIndex = 0;
  public sentMessages: Array<string | Buffer> = [];

  addMessage(msg: string | Buffer) {
    this.messages.push(msg);
  }

  async *rawMessages(): AsyncIterable<string | Buffer> {
    while (this.messageIndex < this.messages.length) {
      yield this.messages[this.messageIndex++];
      // Small delay to allow async processing
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  send(data: string | Buffer): void {
    this.sentMessages.push(data);
  }
}

// ============================================================================
// Basic Controller Creation and Session Tests
// ============================================================================

describe('Contextual Controllers', () => {
  describe('createContextualController()', () => {
    it('should create a contextual controller with session type', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          greet: Procedure('greet').handle((ctx: any) => {
            return { message: `Hello, ${ctx.session.userId}` };
          }),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      assert.ok(instance.procedures, 'Should have procedures array');
      assert.strictEqual(instance.procedures.length, 1);
      assert.strictEqual(instance.procedures[0].name, 'greet');
      assert.strictEqual(instance.procedures[0].path, 'greet');
    });

    it('should inject dependencies into contextual controller', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: { test: TestService },
        routes: (services) => ({
          greet: Procedure('greet').handle((ctx: any) => {
            return services.test.greet(ctx.session.userId);
          }),
        }),
      });

      const container = new Container();
      container.registerClass(TestService);
      container.register(TestController);
      const instance = await container.resolve(TestController);

      assert.ok(instance.procedures);
      assert.strictEqual(instance.procedures.length, 1);
    });

    it('should compile path parameters correctly', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          getRoomById: Procedure('room/:roomId/join').handle(
            ({ params }) => {
              return { roomId: params.roomId };
            }
          ),
          getUserPost: Procedure('user/:userId/post/:postId').handle(
            ({ params }) => {
              return { userId: params.userId, postId: params.postId };
            }
          ),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      assert.strictEqual(instance.procedures.length, 2);

      const roomRoute = instance.procedures.find((p) => p.name === 'getRoomById');
      const postRoute = instance.procedures.find((p) => p.name === 'getUserPost');

      assert.ok(roomRoute);
      assert.ok(postRoute);
      assert.deepStrictEqual(roomRoute.paramNames, ['roomId']);
      assert.deepStrictEqual(postRoute.paramNames, ['userId', 'postId']);
    });
  });

  describe('Session creation', () => {
    it('should create a session with context', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          test: Procedure('test').handle(() => {}),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      const session = instance.createSession({ userId: 'user123' });

      assert.ok(session);
      assert.strictEqual(session.context.userId, 'user123');
    });

    it('should support session options', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          test: Procedure('test').handle(() => {}),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      const session = instance.createSession(
        { userId: 'user123' },
        { defaultTimeout: 5000 }
      );

      assert.ok(session);
      assert.strictEqual(session.context.userId, 'user123');
    });
  });

  describe('Session disposal', () => {
    it('should support Symbol.dispose', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          test: Procedure('test').handle(() => {}),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      const session = instance.createSession({ userId: 'user123' });

      // Should not throw
      session[Symbol.dispose]();
    });

    it('should work with using statement', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          test: Procedure('test').handle(() => {}),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      // Should not throw
      {
        using session = instance.createSession({ userId: 'user123' });
        assert.ok(session);
      }
    });

    it('should call onDispose callbacks in LIFO order', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          test: Procedure('test').handle(() => {}),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      const callOrder: number[] = [];
      const session = instance.createSession({ userId: 'user123' });

      session.onDispose(() => { callOrder.push(1); });
      session.onDispose(() => { callOrder.push(2); });
      session.onDispose(() => { callOrder.push(3); });

      session[Symbol.dispose]();

      // LIFO order: 3, 2, 1
      assert.deepStrictEqual(callOrder, [3, 2, 1]);
    });

    it('should cancel pending requests on disposal', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          longRunning: Procedure('test').handle(async ({ signal }) => {
            // Simulate long-running operation
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(resolve, 1000);
              signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                reject(new Error('Request cancelled'));
              });
            });
            return { done: true };
          }),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      const session = instance.createSession({ userId: 'user123' });
      const request = session.invoke('test', {});

      // Catch the rejection before disposal to avoid unhandled rejection
      const joinPromise = request.join().catch((error) => error);

      // Dispose before completion
      await new Promise((resolve) => setTimeout(resolve, 50));
      session[Symbol.dispose]();

      // Request should be cancelled
      const result = await joinPromise;
      assert.ok(result instanceof Error);
      assert.ok(
        result.message.includes('cancelled') ||
          result.message.includes('disposed')
      );
    });
  });
});

// ============================================================================
// Session.invoke() and ProcedureRequest Tests
// ============================================================================

describe('Session.invoke()', () => {
  it('should return a ProcedureRequest', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        greet: Procedure('greet').handle(() => {
          return { message: 'Hello!' };
        }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });
    const request = session.invoke('greet', {});

    assert.ok(request);
    assert.strictEqual(typeof request.join, 'function');
    assert.strictEqual(typeof request.cancel, 'function');
    assert.strictEqual(typeof request.subscribe, 'function');
    assert.ok('status' in request);

    // Ensure the request completes to avoid unhandled rejection
    await request.join();
  });

  it('should match procedure path with parameters', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        getRoom: Procedure('room/:roomId/info').handle(({ params }) => {
          return { roomId: params.roomId };
        }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });
    const request = session.invoke('room/abc123/info', {});
    const result = (await request.join()) as { roomId: string };

    assert.strictEqual(result.roomId, 'abc123');
  });

  it('should pass session context to handler', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        whoami: Procedure('whoami').handle((ctx: any) => {
          return { userId: ctx.session.userId };
        }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'alice' });
    const request = session.invoke('whoami', {});
    const result = (await request.join()) as { userId: string };

    assert.strictEqual(result.userId, 'alice');
  });

  it('should pass payload as body to handler', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        echo: Procedure('echo').handle(({ body }) => {
          return { received: body };
        }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });
    const payload = { message: 'test' };
    const request = session.invoke('echo', payload);
    const result = (await request.join()) as { received: typeof payload };

    assert.deepStrictEqual(result.received, payload);
  });

  it('should throw ProcedureNotFoundError for unknown procedure', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        existing: Procedure('existing').handle(() => ({ ok: true })),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });
    const request = session.invoke('nonexistent', {});

    await assert.rejects(
      () => request.join(),
      (error: Error) => {
        assert.ok(error instanceof ProcedureNotFoundError);
        assert.strictEqual((error as ProcedureNotFoundError).command, 'nonexistent');
        return true;
      }
    );
  });
});

describe('ProcedureRequest', () => {
  describe('join()', () => {
    it('should return handler result', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          getValue: Procedure('getValue').handle(() => {
            return { value: 42 };
          }),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      using session = instance.createSession({ userId: 'user123' });
      const request = session.invoke('getValue', {});
      const result = (await request.join()) as { value: number };

      assert.strictEqual(result.value, 42);
    });

    it('should handle async handlers', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          asyncValue: Procedure('asyncValue').handle(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { value: 'async' };
          }),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      using session = instance.createSession({ userId: 'user123' });
      const request = session.invoke('asyncValue', {});
      const result = (await request.join()) as { value: string };

      assert.strictEqual(result.value, 'async');
    });

    it('should return final value from generator handler', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          stream: Procedure('stream').handle(async function* () {
            yield { count: 1 };
            yield { count: 2 };
            yield { count: 3 };
          }),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      using session = instance.createSession({ userId: 'user123' });
      const request = session.invoke('stream', {});
      const result = (await request.join()) as { count: number };

      // join() returns the final yielded value
      assert.strictEqual(result.count, 3);
    });
  });

  describe('subscribe()', () => {
    it('should stream values from generator handler', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          stream: Procedure('stream').handle(async function* () {
            yield { count: 1 };
            yield { count: 2 };
            yield { count: 3 };
          }),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      using session = instance.createSession({ userId: 'user123' });
      const request = session.invoke('stream', {});

      // subscribe() streams all values from the generator
      const values: number[] = [];
      for await (const value of request.subscribe()) {
        values.push((value as { count: number }).count);
      }

      // All yielded values should be received
      assert.strictEqual(values.length, 3);
      assert.deepStrictEqual(values, [1, 2, 3]);
    });

    it('should yield single result for non-generator handler', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          single: Procedure('single').handle(() => {
            return { value: 'single' };
          }),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      using session = instance.createSession({ userId: 'user123' });
      const request = session.invoke('single', {});

      const values: string[] = [];
      for await (const value of request.subscribe()) {
        values.push((value as { value: string }).value);
      }

      assert.deepStrictEqual(values, ['single']);
    });
  });

  describe('cancel()', () => {
    it('should cancel pending request and set status to cancelled', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          longRunning: Procedure('test').handle(async ({ signal }) => {
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(resolve, 1000);
              signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                reject(new Error('Cancelled'));
              });
            });
            return { done: true };
          }),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      using session = instance.createSession({ userId: 'user123' });
      const request = session.invoke('test', {});

      // Catch the rejection early to avoid unhandled rejection
      const joinPromise = request.join().catch((error) => error);

      // Wait a bit then cancel
      await new Promise((resolve) => setTimeout(resolve, 50));
      request.cancel();

      assert.strictEqual(request.status, 'cancelled');

      // join() should reject
      const result = await joinPromise;
      assert.ok(result instanceof Error);
    });

    it('should not cancel already completed request', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          quick: Procedure('test').handle(() => {
            return { value: 'done' };
          }),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      using session = instance.createSession({ userId: 'user123' });
      const request = session.invoke('test', {});

      // Wait for completion
      const result = await request.join();
      assert.ok(result);

      // Try to cancel - should be no-op
      request.cancel();

      // Status should be completed, not cancelled
      assert.strictEqual(request.status, 'completed');
    });
  });

  describe('status', () => {
    it('should track request lifecycle states', async () => {
      const TestController = createContextualController<TestSession>().create({
        inject: {},
        routes: () => ({
          async: Procedure('test').handle(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { value: 'done' };
          }),
        }),
      });

      const container = new Container();
      container.register(TestController);
      const instance = await container.resolve(TestController);

      using session = instance.createSession({ userId: 'user123' });
      const request = session.invoke('test', {});

      // Initially pending (or quickly becomes pending)
      assert.ok(
        request.status === 'pending' || request.status === 'completed'
      );

      await request.join();

      // Should be completed after join
      assert.strictEqual(request.status, 'completed');
    });
  });
});

// ============================================================================
// Middleware and Guards Tests
// ============================================================================

describe('Middleware and Guards', () => {
  it('should execute middleware and add to context', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        withMiddleware: Procedure('test')
          .use(async () => {
            return { injected: 'middleware-value' };
          })
          .handle(({ injected }) => {
            return { value: injected };
          }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });
    const request = session.invoke('test', {});
    const result = (await request.join()) as { value: string };

    assert.strictEqual(result.value, 'middleware-value');
  });

  it('should execute guards before handler', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        guarded: Procedure('test')
          .guard((ctx: any) => {
            return ctx.session.userId === 'admin';
          })
          .handle(() => {
            return { allowed: true };
          }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    // Test with admin user - should succeed
    {
      using session = instance.createSession({ userId: 'admin' });
      const request = session.invoke('test', {});
      const result = (await request.join()) as { allowed: boolean };
      assert.strictEqual(result.allowed, true);
    }
  });

  it('should throw GuardDeniedError when guard returns false', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        guarded: Procedure('test')
          .guard((ctx: any) => {
            return ctx.session.userId === 'admin';
          })
          .handle(() => {
            return { allowed: true };
          }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    // Test with non-admin user - should fail
    using session = instance.createSession({ userId: 'regular-user' });
    const request = session.invoke('test', {});

    // Catch the error to verify it's the right type
    const error = await request.join().catch((e) => e);
    assert.ok(error instanceof GuardDeniedError);
  });

  it('should execute multiple middleware in order', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        chain: Procedure('test')
          .use(async () => {
            return { first: '1' };
          })
          .use(async ({ first }) => {
            return { second: first + '2' };
          })
          .use(async ({ second }) => {
            return { third: second + '3' };
          })
          .handle(({ third }) => {
            return { result: third };
          }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });
    const request = session.invoke('test', {});
    const result = (await request.join()) as { result: string };

    assert.strictEqual(result.result, '123');
  });
});

// ============================================================================
// Body Validation Tests
// ============================================================================

describe('Body validation', () => {
  it('should validate body with zod schema', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        createUser: Procedure('createUser')
          .body(
            z.object({
              name: z.string(),
              age: z.number(),
            })
          )
          .handle(({ body }) => {
            return { user: body };
          }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });
    const request = session.invoke('createUser', {
      name: 'Alice',
      age: 30,
    });
    const result = (await request.join()) as {
      user: { name: string; age: number };
    };

    assert.strictEqual(result.user.name, 'Alice');
    assert.strictEqual(result.user.age, 30);
  });

  it('should reject invalid body', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        createUser: Procedure('createUser')
          .body(
            z.object({
              name: z.string(),
              age: z.number(),
            })
          )
          .handle(({ body }) => {
            return { user: body };
          }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });
    const request = session.invoke('createUser', {
      name: 'Alice',
      age: 'invalid', // Should be number
    });

    // Catch the error to verify it's a validation error
    const error = await request.join().catch((e) => e);
    assert.ok(error instanceof Error);
  });
});

// ============================================================================
// Timeout Tests
// ============================================================================

describe('Timeout handling', () => {
  it('should throw TimeoutError when procedure exceeds timeout', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        slow: Procedure('test')
          .timeout(50)
          .handle(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return { done: true };
          }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });
    const request = session.invoke('test', {});

    // Catch the error to verify it's a TimeoutError
    const error = await request.join().catch((e) => e);
    assert.ok(error instanceof TimeoutError);
    assert.strictEqual((error as TimeoutError).timeoutMs, 50);
  });

  it('should complete before timeout', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        fast: Procedure('test')
          .timeout(1000)
          .handle(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { done: true };
          }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });
    const request = session.invoke('test', {});
    const result = (await request.join()) as { done: boolean };

    assert.strictEqual(result.done, true);
    assert.strictEqual(request.status, 'completed');
  });

  it('should use default timeout from session options', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        slow: Procedure('test').handle(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { done: true };
        }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession(
      { userId: 'user123' },
      { defaultTimeout: 50 }
    );
    const request = session.invoke('test', {});

    // Catch the error to verify it's a TimeoutError
    const error = await request.join().catch((e) => e);
    assert.ok(error instanceof TimeoutError);
  });
});

// ============================================================================
// Session.run() Tests
// ============================================================================

describe('Session.run()', () => {
  it('should process messages from rawMessages()', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        echo: Procedure('echo').handle(({ body }) => {
          return { echoed: body };
        }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    const ws = new MockWebSocket();
    ws.addMessage(JSON.stringify({ command: 'echo', payload: { msg: 'hello' } }));
    ws.addMessage(JSON.stringify({ command: 'echo', payload: { msg: 'world' } }));

    using session = instance.createSession({ userId: 'user123', ws });

    // Run in background
    const runPromise = session.run();

    // Wait for messages to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Dispose to stop run loop
    session[Symbol.dispose]();

    await runPromise;

    // Check sent messages
    assert.strictEqual(ws.sentMessages.length, 2);
    const msg1 = JSON.parse(ws.sentMessages[0] as string);
    const msg2 = JSON.parse(ws.sentMessages[1] as string);

    assert.deepStrictEqual(msg1.echoed, { msg: 'hello' });
    assert.deepStrictEqual(msg2.echoed, { msg: 'world' });
  });

  it('should send error response for invalid procedure', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        existing: Procedure('existing').handle(() => {
          return { ok: true };
        }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    const ws = new MockWebSocket();
    ws.addMessage(
      JSON.stringify({ command: 'nonexistent', payload: {} })
    );

    using session = instance.createSession({ userId: 'user123', ws });

    const runPromise = session.run();

    await new Promise((resolve) => setTimeout(resolve, 100));
    session[Symbol.dispose]();
    await runPromise;

    assert.strictEqual(ws.sentMessages.length, 1);
    const response = JSON.parse(ws.sentMessages[0] as string);
    assert.ok(response.error);
    assert.ok(response.error.includes('not found'));
  });

  it('should support custom parse and serialize options', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        test: Procedure('test').handle(() => {
          return { value: 42 };
        }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    const ws = new MockWebSocket();
    // Custom format: "COMMAND:PAYLOAD"
    ws.addMessage('test:{}');

    using session = instance.createSession({ userId: 'user123', ws });

    const runPromise = session.run({
      parse: (raw) => {
        const str = raw.toString();
        const [command, payload] = str.split(':');
        return { command, payload: JSON.parse(payload) };
      },
      serialize: (result) => {
        return `RESULT:${JSON.stringify(result)}`;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    session[Symbol.dispose]();
    await runPromise;

    assert.strictEqual(ws.sentMessages.length, 1);
    const response = ws.sentMessages[0] as string;
    assert.ok(response.startsWith('RESULT:'));
    assert.ok(response.includes('42'));
  });

  it('should throw error if context has no ws', async () => {
    const TestController = createContextualController<TestSession>().create({
      inject: {},
      routes: () => ({
        test: Procedure('test').handle(() => {
          return { ok: true };
        }),
      }),
    });

    const container = new Container();
    container.register(TestController);
    const instance = await container.resolve(TestController);

    using session = instance.createSession({ userId: 'user123' });

    await assert.rejects(
      () => session.run(),
      (error: Error) => {
        assert.ok(error.message.includes('ws'));
        return true;
      }
    );
  });
});
