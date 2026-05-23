/**
 * End-to-end tests for contract-based controllers.
 *
 * Tests the full flow:
 * 1. Define contracts using defineContract()
 * 2. Implement controllers using createController.implements()
 * 3. Resolve through DI
 * 4. Execute RPC methods
 */

import { test, describe, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  defineContract,
  rpc,
  simpleMessage,
  createController,
  Container,
  defineService,
  type MessageSchema,
  type RpcContext,
  type ContractControllerInstance,
  CONTRACT_METADATA,
} from '../../src/index.js';

// ============================================================================
// Test Message Types and Schemas
// ============================================================================

interface HelloRequest {
  name: string
}

interface HelloReply {
  message: string
}

interface ChatMessage {
  text: string
  timestamp: number
}

interface ListRequest {
  page: number
  pageSize: number
}

interface ListResponse {
  items: string[]
  total: number
}

// Simple schemas for testing (no encode/decode needed)
const HelloRequestSchema = simpleMessage<HelloRequest>('HelloRequest');
const HelloReplySchema = simpleMessage<HelloReply>('HelloReply');
const ChatMessageSchema = simpleMessage<ChatMessage>('ChatMessage');
const ListRequestSchema = simpleMessage<ListRequest>('ListRequest');
const ListResponseSchema = simpleMessage<ListResponse>('ListResponse');

// ============================================================================
// Test Contracts
// ============================================================================

// Simple unary service
abstract class GreeterService extends defineContract({
  protocol: 'grpc',
  serviceName: 'test.Greeter',
  methods: {
    sayHello: rpc(HelloRequestSchema, HelloReplySchema),
    sayGoodbye: rpc(HelloRequestSchema, HelloReplySchema),
  },
}) {}

// Service with streaming
abstract class StreamingService extends defineContract({
  protocol: 'grpc',
  serviceName: 'test.Streaming',
  methods: {
    serverStream: rpc(ListRequestSchema, HelloReplySchema).serverStream(),
    clientStream: rpc(ChatMessageSchema, ListResponseSchema).clientStream(),
    bidiStream: rpc(ChatMessageSchema, ChatMessageSchema).bidiStream(),
  },
}) {}

// ============================================================================
// Test Services (for dependency injection)
// ============================================================================

class GreetingRepository extends defineService({
  inject: {},
  factory: () => ({
    getGreeting: (name: string) => `Hello, ${name}!`,
    getFarewell: (name: string) => `Goodbye, ${name}!`,
  }),
}) {}

// ============================================================================
// Tests
// ============================================================================

describe('Contract-Based Controllers E2E', () => {
  let container: Container;

  beforeEach(() => {
    container = new Container();
  });

  describe('defineContract', () => {
    test('should create contract with metadata', () => {
      const metadata = (GreeterService as any)[CONTRACT_METADATA];

      assert.ok(metadata, 'Contract should have metadata');
      assert.strictEqual(metadata.protocol, 'grpc');
      assert.strictEqual(metadata.serviceName, 'test.Greeter');
      assert.ok(metadata.methods.sayHello, 'Should have sayHello method');
      assert.ok(metadata.methods.sayGoodbye, 'Should have sayGoodbye method');
    });

    test('should track streaming modes correctly', () => {
      const metadata = (StreamingService as any)[CONTRACT_METADATA];

      assert.strictEqual(metadata.methods.serverStream.streaming, 'server');
      assert.strictEqual(metadata.methods.clientStream.streaming, 'client');
      assert.strictEqual(metadata.methods.bidiStream.streaming, 'bidi');
    });

    test('should throw when instantiated directly', () => {
      assert.throws(
        () => new (GreeterService as any)(),
        /cannot be instantiated directly/
      );
    });
  });

  describe('createController.implements()', () => {
    test('should create controller implementing contract', async () => {
      // Create controller
      const GreeterController = createController
        .implements(GreeterService)
        .create({
          inject: {},
          methods: () => ({
            sayHello: async ({ body }) => ({
              message: `Hello, ${body.name}!`,
            }),
            sayGoodbye: async ({ body }) => ({
              message: `Goodbye, ${body.name}!`,
            }),
          }),
        });

      // Register and resolve
      container.register(GreeterController);
      const instance = await container.resolve(GreeterController);

      // Verify instance structure
      assert.ok(instance.contract, 'Should have contract reference');
      assert.ok(instance.metadata, 'Should have metadata');
      assert.ok(instance.methods, 'Should have methods map');
      assert.strictEqual(instance.methods.size, 2);
    });

    test('should execute unary RPC method', async () => {
      const GreeterController = createController
        .implements(GreeterService)
        .create({
          inject: {},
          methods: () => ({
            sayHello: async ({ body }) => ({
              message: `Hello, ${body.name}!`,
            }),
            sayGoodbye: async ({ body }) => ({
              message: `Goodbye, ${body.name}!`,
            }),
          }),
        });

      container.register(GreeterController);
      const instance = await container.resolve(GreeterController);

      // Execute method
      const handler = instance.methods.get('sayHello')!.handler;
      const ctx: RpcContext<HelloRequest> = {
        body: { name: 'World' },
        metadata: new Map(),
        signal: new AbortController().signal,
        session: {},
      };

      const result = await handler(ctx);
      assert.deepStrictEqual(result, { message: 'Hello, World!' });
    });

    test('should inject dependencies into controller', async () => {
      const GreeterController = createController
        .implements(GreeterService)
        .create({
          inject: { repo: GreetingRepository },
          methods: ({ repo }) => ({
            sayHello: async ({ body }) => ({
              message: repo.getGreeting(body.name),
            }),
            sayGoodbye: async ({ body }) => ({
              message: repo.getFarewell(body.name),
            }),
          }),
        });

      container.register(GreetingRepository);
      container.register(GreeterController);
      const instance = await container.resolve(GreeterController);

      const handler = instance.methods.get('sayGoodbye')!.handler;
      const ctx: RpcContext<HelloRequest> = {
        body: { name: 'Alice' },
        metadata: new Map(),
        signal: new AbortController().signal,
        session: {},
      };

      const result = await handler(ctx);
      assert.deepStrictEqual(result, { message: 'Goodbye, Alice!' });
    });

    test('should error at runtime if method missing', async () => {
      // Create controller with missing method
      const PartialController = createController
        .implements(GreeterService)
        .create({
          inject: {},
          methods: () => ({
            sayHello: async ({ body }: { body: HelloRequest }) => ({
              message: `Hello, ${body.name}!`,
            }),
            // Missing sayGoodbye - will error at factory time
          } as any),
        });

      container.register(PartialController);

      await assert.rejects(
        container.resolve(PartialController),
        /not implemented/
      );
    });
  });

  describe('Server Streaming', () => {
    test('should execute server streaming method', async () => {
      const StreamController = createController
        .implements(StreamingService)
        .create({
          inject: {},
          methods: () => ({
            serverStream: async function* ({ body }) {
              for (let i = 0; i < body.pageSize; i++) {
                yield { message: `Item ${body.page * body.pageSize + i}` };
              }
            },
            clientStream: async ({ body }) => ({
              items: [],
              total: 0,
            }),
            bidiStream: async function* () {
              yield { text: 'echo', timestamp: Date.now() };
            },
          }),
        });

      container.register(StreamController);
      const instance = await container.resolve(StreamController);

      const handler = instance.methods.get('serverStream')!.handler;
      const ctx: RpcContext<ListRequest> = {
        body: { page: 0, pageSize: 3 },
        metadata: new Map(),
        signal: new AbortController().signal,
        session: {},
      };

      const generator = handler(ctx) as AsyncGenerator<HelloReply>;
      const results: HelloReply[] = [];

      for await (const item of generator) {
        results.push(item);
      }

      assert.strictEqual(results.length, 3);
      assert.deepStrictEqual(results[0], { message: 'Item 0' });
      assert.deepStrictEqual(results[1], { message: 'Item 1' });
      assert.deepStrictEqual(results[2], { message: 'Item 2' });
    });
  });

  describe('Bidirectional Streaming', () => {
    test('should execute bidi streaming method', async () => {
      const StreamController = createController
        .implements(StreamingService)
        .create({
          inject: {},
          methods: () => ({
            serverStream: async function* () {
              yield { message: 'item' };
            },
            clientStream: async () => ({ items: [], total: 0 }),
            bidiStream: async function* ({ body }) {
              // Echo back each message with a response
              for await (const msg of body as AsyncIterable<ChatMessage>) {
                yield { text: `Echo: ${msg.text}`, timestamp: Date.now() };
              }
            },
          }),
        });

      container.register(StreamController);
      const instance = await container.resolve(StreamController);

      // Create mock incoming stream
      async function* mockIncoming(): AsyncGenerator<ChatMessage> {
        yield { text: 'Hello', timestamp: 1 };
        yield { text: 'World', timestamp: 2 };
      }

      const handler = instance.methods.get('bidiStream')!.handler;
      const ctx = {
        body: mockIncoming(),
        metadata: new Map(),
        signal: new AbortController().signal,
        session: {},
      };

      const generator = handler(ctx) as AsyncGenerator<ChatMessage>;
      const results: ChatMessage[] = [];

      for await (const item of generator) {
        results.push(item);
      }

      assert.strictEqual(results.length, 2);
      assert.ok(results[0].text.includes('Echo: Hello'));
      assert.ok(results[1].text.includes('Echo: World'));
    });
  });

  describe('Contract Metadata Access', () => {
    test('should provide access to input/output schemas', async () => {
      const GreeterController = createController
        .implements(GreeterService)
        .create({
          inject: {},
          methods: () => ({
            sayHello: async ({ body }) => ({ message: `Hi ${body.name}` }),
            sayGoodbye: async ({ body }) => ({ message: `Bye ${body.name}` }),
          }),
        });

      container.register(GreeterController);
      const instance = await container.resolve(GreeterController);

      const sayHelloMethod = instance.methods.get('sayHello')!;
      assert.strictEqual(sayHelloMethod.inputSchema.$name, 'HelloRequest');
      assert.strictEqual(sayHelloMethod.outputSchema.$name, 'HelloReply');
      assert.strictEqual(sayHelloMethod.streaming, 'unary');
    });

    test('should preserve full service metadata', async () => {
      const GreeterController = createController
        .implements(GreeterService)
        .create({
          inject: {},
          methods: () => ({
            sayHello: async ({ body }) => ({ message: `Hi ${body.name}` }),
            sayGoodbye: async ({ body }) => ({ message: `Bye ${body.name}` }),
          }),
        });

      container.register(GreeterController);
      const instance = await container.resolve(GreeterController);

      assert.strictEqual(instance.metadata.protocol, 'grpc');
      assert.strictEqual(instance.metadata.serviceName, 'test.Greeter');
      assert.ok(instance.metadata.methods.sayHello);
      assert.ok(instance.metadata.methods.sayGoodbye);
    });
  });

  describe('Type Safety', () => {
    test('simpleMessage should create valid schema', () => {
      const schema = simpleMessage<{ foo: string }>('TestMessage');

      assert.strictEqual(schema.$type, 'message');
      assert.strictEqual(schema.$name, 'TestMessage');
      assert.ok(typeof schema.create === 'function');

      const instance = schema.create({ foo: 'bar' });
      assert.deepStrictEqual(instance, { foo: 'bar' });
    });

    test('rpc() should chain streaming modes', () => {
      const unary = rpc(HelloRequestSchema, HelloReplySchema);
      assert.strictEqual(unary.streaming, 'unary');

      const server = rpc(HelloRequestSchema, HelloReplySchema).serverStream();
      assert.strictEqual(server.streaming, 'server');

      const client = rpc(HelloRequestSchema, HelloReplySchema).clientStream();
      assert.strictEqual(client.streaming, 'client');

      const bidi = rpc(HelloRequestSchema, HelloReplySchema).bidiStream();
      assert.strictEqual(bidi.streaming, 'bidi');
    });
  });
});
