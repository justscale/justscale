/**
 * Type-level tests for contextual controllers feature.
 *
 * These tests verify that types flow correctly through the builder chain
 * and that the TypeScript compiler catches expected errors.
 *
 * Tests should compile successfully where intended, and fail to compile
 * (marked with @ts-expect-error) where they should reject invalid usage.
 */

import type { ProcedureContext, Session } from '../src/index.js';
import { Procedure } from '../src/index.js';
import { createProcedureFactory } from '../src/core/controller.procedure.js';
import { z } from 'zod';

// ============================================================================
// Test Setup - Session Context Types
// ============================================================================

interface GameSession {
  user: { id: string; name: string };
  ws: { send: (data: string) => void };
}

interface AdminSession {
  admin: { id: string; permissions: string[] };
  ip: string;
}

// ============================================================================
// Test 1: Context type flows correctly through Procedure builder chain
// ============================================================================

// Basic procedure with session context
const basicProcedure = Procedure<string>('test/action')
  .handle(({ session, params, body, signal }) => {
    // session should be unknown in untyped Procedure
    const _session: unknown = session;

    // params should be empty object for path without params
    const _params: {} = params;

    // body should be unknown without schema
    const _body: unknown = body;

    // signal should be AbortSignal
    const _signal: AbortSignal = signal;

    return { success: true };
  });

// ============================================================================
// Test 2: .body() properly types the body in handler context
// ============================================================================

const bodySchema = z.object({
  amount: z.number(),
  message: z.string().optional(),
});

type BodyType = z.infer<typeof bodySchema>;

const procedureWithBody = Procedure('room/:roomId/bet')
  .body(bodySchema)
  .handle(({ body, params }) => {
    // body should be typed after .body()
    const _amount: number = body.amount;
    const _message: string | undefined = body.message;

    // params should have roomId extracted
    const _roomId: string = params.roomId;

    return { accepted: true };
  });

// Should error: body should not be accessible before .body() is called with wrong type
const procedureBodyError = Procedure('test')
  .handle(({ body }) => {
    // @ts-expect-error - body is unknown before .body() is called
    const _amount: number = body.amount;
    return {};
  });

// ============================================================================
// Test 3: Middleware .use() accumulates types correctly
// ============================================================================

interface Room {
  id: string;
  players: string[];
}

const procedureWithMiddleware = Procedure('room/:roomId/action')
  .use(async ({ params }) => {
    // Middleware has access to params
    const roomId: string = params.roomId;

    // Return value extends context
    return {
      room: { id: roomId, players: [] } as Room,
    };
  })
  .handle(({ room, params }) => {
    // room should be available from middleware
    const _room: Room = room;
    const _players: string[] = room.players;

    // params still available
    const _roomId: string = params.roomId;

    return { room };
  });

// Multiple middleware should accumulate
const multipleMiddleware = Procedure('test')
  .use(async () => ({ foo: 'bar' }))
  .use(async () => ({ baz: 42 }))
  .handle(({ foo, baz }) => {
    const _foo: string = foo;
    const _baz: number = baz;
    return { foo, baz };
  });

// Middleware can reference earlier middleware but not later ones
const middlewareOrder = Procedure('test')
  .use(async () => ({ first: 'value' }))
  .use(async ({ first }) => {
    // first is available from earlier middleware
    const _first: string = first;
    return { second: 42 };
  })
  .handle(() => ({}));

// ============================================================================
// Test 4: Session context type is available in handlers as `session`
// ============================================================================

// Create a typed Procedure factory bound to GameSession
const GameProcedure = createProcedureFactory<GameSession>();

const joinProcedure = GameProcedure('room/:roomId/join')
  .handle(({ session, params }) => {
    // session should have GameSession type
    const _user: { id: string; name: string } = session.user;
    const _ws: { send: (data: string) => void } = session.ws;
    const _roomId: string = params.roomId;

    session.ws.send(`${session.user.name} joined room ${params.roomId}`);

    return { joined: params.roomId, user: session.user.id };
  });

const betProcedure = GameProcedure('room/:roomId/bet')
  .body(z.object({ amount: z.number() }))
  .use(async ({ params }) => ({
    room: { id: params.roomId, players: [] } as Room,
  }))
  .handle(({ session, params, body, room }) => {
    // All types should be available
    const _userId: string = session.user.id;
    const _roomId: string = params.roomId;
    const _amount: number = body.amount;
    const _players: string[] = room.players;

    return { accepted: true };
  });

// ============================================================================
// Test 5: Path params are extracted and typed in `params`
// ============================================================================

const complexPathParams = Procedure('users/:userId/posts/:postId/comments/:commentId')
  .handle(({ params }) => {
    // All params should be extracted as strings
    const _userId: string = params.userId;
    const _postId: string = params.postId;
    const _commentId: string = params.commentId;

    // @ts-expect-error - nonexistent param should error
    const _invalid = params.nonexistent;

    return { params };
  });

// Params should be empty object for path without params
const noParams = Procedure('static/path')
  .handle(({ params }) => {
    // params should be {}
    const _params: {} = params;

    // @ts-expect-error - should have no properties
    const _invalid = params.anything;

    return {};
  });

// ============================================================================
// Test 6: Procedure factory properly constrains session type
// ============================================================================

// Create a typed Procedure factory bound to AdminSession
const AdminProcedure = createProcedureFactory<AdminSession>();

const banUserProcedure = AdminProcedure('admin/ban/:userId')
  .handle(({ session, params }) => {
    // session should have AdminSession type
    const _admin: { id: string; permissions: string[] } = session.admin;
    const _ip: string = session.ip;
    const _userId: string = params.userId;

    return { banned: params.userId, by: session.admin.id };
  });

// Session type should be enforced - can't access wrong properties
const wrongSessionAccess = GameProcedure('test')
  .handle(({ session }) => {
    // @ts-expect-error - admin is not on GameSession
    const _admin = session.admin;

    // These should work
    const _user = session.user;
    const _ws = session.ws;

    return {};
  });

// ============================================================================
// Test 7: Body and middleware interact correctly
// ============================================================================

const bodyAndMiddleware = Procedure('action')
  .body(z.object({ value: z.string() }))
  .use(async ({ body }) => {
    // Middleware should see typed body
    const _value: string = body.value;
    return { processed: body.value.toUpperCase() };
  })
  .handle(({ body, processed }) => {
    // Handler sees both
    const _value: string = body.value;
    const _processed: string = processed;

    return { original: body.value, processed };
  });

// ============================================================================
// Test 8: Guards don't affect type accumulation
// ============================================================================

const withGuard = Procedure('protected')
  .use(async () => ({ userId: '123' }))
  .guard(({ userId }) => {
    // Guard has access to middleware context
    const _userId: string = userId;
    return userId === '123';
  })
  .use(async () => ({ isAuthorized: true }))
  .handle(({ userId, isAuthorized }) => {
    // Handler has access to all middleware, guard doesn't add to context
    const _userId: string = userId;
    const _authorized: boolean = isAuthorized;

    return { userId, isAuthorized };
  });

// ============================================================================
// Test 9: Session type constraint propagates through builder
// ============================================================================

const SocketProcedure = createProcedureFactory<{ socket: WebSocket }>();

const sendProcedure = SocketProcedure('send')
  .body(z.object({ message: z.string() }))
  .handle(({ session, body }) => {
    // session should have socket property
    const _socket: WebSocket = session.socket;

    // @ts-expect-error - session should not have user property
    const _user = session.user;

    return { sent: true };
  });

// ============================================================================
// Test 10: Complex middleware chain preserves all types
// ============================================================================

const complexChain = Procedure('complex/:id')
  .body(z.object({ input: z.number() }))
  .use(async ({ params }) => ({
    entity: { id: params.id, name: 'test' },
  }))
  .use(async ({ body, entity }) => ({
    calculated: body.input * 2,
    entityName: entity.name,
  }))
  .use(async ({ calculated }) => ({
    result: `Result: ${calculated}`,
  }))
  .handle(({ params, body, entity, calculated, entityName, result }) => {
    // All types should be preserved
    const _id: string = params.id;
    const _input: number = body.input;
    const _entity: { id: string; name: string } = entity;
    const _calculated: number = calculated;
    const _entityName: string = entityName;
    const _result: string = result;

    return { params, body, entity, calculated, entityName, result };
  });

// ============================================================================
// Test 11: ProcedureContext type helper works correctly
// ============================================================================

// Basic procedure context
type BasicContext = ProcedureContext<GameSession, { roomId: string }, { amount: number }>;

// Should have all required properties
const _testBasicContext: BasicContext = {
  session: { user: { id: '1', name: 'test' }, ws: { send: () => {} } },
  params: { roomId: 'room1' },
  body: { amount: 100 },
  signal: new AbortController().signal,
  logger: {} as any,
  onCleanup: () => {},
};

// Session type is correctly extracted
const _testSession: BasicContext['session'] = {
  user: { id: '1', name: 'test' },
  ws: { send: () => {} },
};

// @ts-expect-error - params must match exact type
const _wrongParams: BasicContext['params'] = { wrongKey: 'value' };

// @ts-expect-error - body must match exact type
const _wrongBody: BasicContext['body'] = { wrongField: 'value' };

// ============================================================================
// Test 12: Session instance typing
// ============================================================================

// Session should be typed with the context type
declare const gameSession: Session<GameSession>;

// Context should be accessible and typed
const _sessionContext: GameSession = gameSession.context;
const _sessionUser = gameSession.context.user;
const _sessionWs = gameSession.context.ws;

// Methods should be available
gameSession.invoke('test', {});
gameSession.onDispose(() => {});

// ============================================================================
// Test 13: Timeout and other builder methods preserve types
// ============================================================================

const withTimeout = Procedure('timed')
  .body(z.object({ data: z.string() }))
  .timeout(5000)
  .use(async () => ({ timestamp: Date.now() }))
  .handle(({ body, timestamp }) => {
    const _data: string = body.data;
    const _time: number = timestamp;
    return { body, timestamp };
  });

const withReturns = Procedure('typed-response')
  .returns(z.object({ success: z.boolean() }))
  .handle(() => {
    return { success: true };
  });

// ============================================================================
// Test 14: Builtin context properties are always available
// ============================================================================

const withBuiltins = Procedure('test')
  .handle(({ logger, onCleanup, signal }) => {
    // These should always be available from BuiltinContext
    logger.info('test');
    onCleanup(() => {});
    const _aborted: boolean = signal.aborted;

    return {};
  });

// ============================================================================
// Test 15: Multiple procedures maintain separate types
// ============================================================================

const firstProc = GameProcedure('first')
  .body(z.object({ a: z.string() }))
  .use(async () => ({ x: 1 }))
  .handle(({ body, x }) => {
    const _a: string = body.a;
    const _x: number = x;
    // @ts-expect-error - b is not on this procedure
    const _b = body.b;
    // @ts-expect-error - y is not on this procedure (x is number, not string)
    const _y: string = x;
    return { a: body.a, x };
  });

const secondProc = GameProcedure('second')
  .body(z.object({ b: z.number() }))
  .use(async () => ({ y: 'string' }))
  .handle(({ body, y }) => {
    const _b: number = body.b;
    const _y: string = y;
    // @ts-expect-error - a is not on this procedure
    const _a = body.a;
    // @ts-expect-error - x is not on this procedure
    const _x = x;
    return { b: body.b, y };
  });

// ============================================================================
// Test 16: Empty middleware doesn't break type chain
// ============================================================================

const emptyMiddleware = Procedure('test')
  .use(async () => ({}))  // Returns empty object
  .use(async () => ({ value: 42 }))
  .handle(({ value }) => {
    const _value: number = value;
    return { value };
  });

// ============================================================================
// End of type tests
// ============================================================================

// Export to prevent "unused" errors
export type {
  BasicContext,
};
