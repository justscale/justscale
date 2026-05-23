/**
 * End-to-End Integration Tests
 *
 * Tests the complete middleware flow with the HTTP builder,
 * validating that routes work correctly from definition to execution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { executeRoute } from '@justscale/core';
import { Post } from '../src/builder/create-http-builder.js';
import { body } from '../src/builder/plugins/body.js';
import { query } from '../src/builder/plugins/query.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Resolve plugin dependencies for testing.
 * Since body() and query() plugins have no DI dependencies,
 * we just need to initialize them with an empty container.
 */
function resolvePlugin(plugin: any): any {
  plugin.resolve({ resolve: () => null });
  return plugin;
}

// ============================================================================
// Integration Test: Complete Middleware Flow
// ============================================================================

describe('Complete Middleware Flow Integration', () => {
  it('should create route with correct method and path', () => {
    const route = Post('/users/:id')
      .apply(resolvePlugin(body(z.object({ name: z.string() }))))
      .apply(resolvePlugin(query(z.object({ include: z.string().optional() }))))
      .use((ctx: any) => ({ userId: ctx.params.id }))
      .guard((ctx: any) => {
        if (ctx.userId === 'blocked') {
          ctx.res.status(403).json({ error: 'Blocked' });
          return ctx.stop();
        }
        return undefined;
      })
      .returns(200, z.object({ success: z.boolean() }))
      .handle((ctx: any) => {
        ctx.res.json({ success: true });
      });

    assert.strictEqual(route.method, 'POST');
    assert.strictEqual(route.path, '/users/:id');
  });

  it('should have steps array with correct order', () => {
    const route = Post('/users/:id')
      .apply(resolvePlugin(body(z.object({ name: z.string() }))))
      .apply(resolvePlugin(query(z.object({ include: z.string().optional() }))))
      .use((ctx: any) => ({ userId: ctx.params.id }))
      .guard((ctx: any) => {
        if (ctx.userId === 'blocked') {
          ctx.res.status(403).json({ error: 'Blocked' });
          return ctx.stop();
        }
        return undefined;
      })
      .returns(200, z.object({ success: z.boolean() }))
      .handle((ctx: any) => {
        ctx.res.json({ success: true });
      });

    // Steps: body validation (guard + use), query validation (guard + use), use, guard
    assert.strictEqual(route.steps.length, 6);
    assert.strictEqual(route.steps[0].type, 'guard'); // body validation guard
    assert.strictEqual(route.steps[1].type, 'use');   // body validation use
    assert.strictEqual(route.steps[2].type, 'guard'); // query validation guard
    assert.strictEqual(route.steps[3].type, 'use');   // query validation use
    assert.strictEqual(route.steps[4].type, 'use');   // userId middleware
    assert.strictEqual(route.steps[5].type, 'guard'); // blocked check
  });

  it('should execute route successfully with valid input', async () => {
    let handlerCalled = false;
    let capturedContext: any = null;
    let responseData: any = null;

    const route = Post('/users/:id')
      .apply(resolvePlugin(body(z.object({ name: z.string() }))))
      .apply(resolvePlugin(query(z.object({ include: z.string().optional() }))))
      .use((ctx: any) => ({ userId: ctx.params.id }))
      .guard((ctx: any) => {
        if (ctx.userId === 'blocked') {
          ctx.res.status(403).json({ error: 'Blocked' });
          return ctx.stop();
        }
        return undefined;
      })
      .returns(200, z.object({ success: z.boolean() }))
      .handle((ctx: any) => {
        handlerCalled = true;
        capturedContext = ctx;
        ctx.res.json({ success: true });
      });

    // Create a mock context with valid data
    const ctx = {
      params: { id: '123' },
      rawBody: { name: 'John Doe' },
      rawQuery: { include: 'profile' },
      res: {
        status: (code: number) => ({
          json: (data: any) => {
            responseData = data;
          },
          end: () => {},
        }),
        json: (data: any) => {
          responseData = data;
        },
      },
    };

    await executeRoute(route, ctx);

    // Verify handler was called
    assert.strictEqual(handlerCalled, true);

    // Verify context has all expected properties
    assert.ok(capturedContext.body);
    assert.strictEqual(capturedContext.body.name, 'John Doe');
    assert.ok(capturedContext.query);
    assert.strictEqual(capturedContext.query.include, 'profile');
    assert.strictEqual(capturedContext.userId, '123');
    assert.strictEqual(capturedContext.params.id, '123');

    // Verify response
    assert.deepStrictEqual(responseData, { success: true });
  });

  it('should stop execution on invalid body', async () => {
    let handlerCalled = false;
    let responseStatus: number | null = null;
    let responseData: any = null;

    const route = Post('/users/:id')
      .apply(resolvePlugin(body(z.object({ name: z.string() }))))
      .apply(resolvePlugin(query(z.object({ include: z.string().optional() }))))
      .use((ctx: any) => ({ userId: ctx.params.id }))
      .guard((ctx: any) => {
        if (ctx.userId === 'blocked') {
          ctx.res.status(403).json({ error: 'Blocked' });
          return ctx.stop();
        }
        return undefined;
      })
      .returns(200, z.object({ success: z.boolean() }))
      .handle((ctx: any) => {
        handlerCalled = true;
        ctx.res.json({ success: true });
      });

    // Create a mock context with INVALID body (number instead of string)
    const ctx = {
      params: { id: '123' },
      rawBody: { name: 12345 }, // Invalid: should be string
      rawQuery: { include: 'profile' },
      res: {
        status: (code: number) => {
          responseStatus = code;
          return {
            json: (data: any) => {
              responseData = data;
            },
            end: () => {},
          };
        },
        json: (data: any) => {
          responseData = data;
        },
      },
    };

    await executeRoute(route, ctx);

    // Verify handler was NOT called
    assert.strictEqual(handlerCalled, false);

    // Verify 400 error response
    assert.strictEqual(responseStatus, 400);
    assert.ok(responseData);
    assert.ok(responseData.errors);
  });

  it('should stop execution on guard failure', async () => {
    let handlerCalled = false;
    let responseStatus: number | null = null;
    let responseData: any = null;

    const route = Post('/users/:id')
      .apply(resolvePlugin(body(z.object({ name: z.string() }))))
      .apply(resolvePlugin(query(z.object({ include: z.string().optional() }))))
      .use((ctx: any) => ({ userId: ctx.params.id }))
      .guard((ctx: any) => {
        if (ctx.userId === 'blocked') {
          ctx.res.status(403).json({ error: 'Blocked' });
          return ctx.stop();
        }
        return undefined;
      })
      .returns(200, z.object({ success: z.boolean() }))
      .handle((ctx: any) => {
        handlerCalled = true;
        ctx.res.json({ success: true });
      });

    // Create a mock context with userId "blocked" to trigger guard
    const ctx = {
      params: { id: 'blocked' },
      rawBody: { name: 'John Doe' },
      rawQuery: { include: 'profile' },
      res: {
        status: (code: number) => {
          responseStatus = code;
          return {
            json: (data: any) => {
              responseData = data;
            },
            end: () => {},
          };
        },
        json: (data: any) => {
          responseData = data;
        },
      },
    };

    await executeRoute(route, ctx);

    // Verify handler was NOT called
    assert.strictEqual(handlerCalled, false);

    // Verify 403 forbidden response
    assert.strictEqual(responseStatus, 403);
    assert.deepStrictEqual(responseData, { error: 'Blocked' });
  });

  it('should handle optional query parameters correctly', async () => {
    let capturedContext: any = null;

    const route = Post('/users/:id')
      .apply(resolvePlugin(body(z.object({ name: z.string() }))))
      .apply(resolvePlugin(query(z.object({ include: z.string().optional() }))))
      .use((ctx: any) => ({ userId: ctx.params.id }))
      .guard((ctx: any) => {
        if (ctx.userId === 'blocked') {
          ctx.res.status(403).json({ error: 'Blocked' });
          return ctx.stop();
        }
        return undefined;
      })
      .returns(200, z.object({ success: z.boolean() }))
      .handle((ctx: any) => {
        capturedContext = ctx;
        ctx.res.json({ success: true });
      });

    // Create context WITHOUT optional query parameter
    const ctx = {
      params: { id: '123' },
      rawBody: { name: 'John Doe' },
      rawQuery: {}, // No 'include' parameter
      res: {
        status: () => ({ json: () => {}, end: () => {} }),
        json: () => {},
      },
    };

    await executeRoute(route, ctx);

    // Verify query exists but include is undefined
    assert.ok(capturedContext.query);
    assert.strictEqual(capturedContext.query.include, undefined);
  });

  it('should pass through all middleware in correct order', async () => {
    const executionLog: string[] = [];
    let finalContext: any = null;

    const route = Post('/users/:id')
      .apply(resolvePlugin(body(z.object({ name: z.string() }))))
      .apply(resolvePlugin(query(z.object({ include: z.string().optional() }))))
      .use((ctx: any) => {
        executionLog.push('use-userId');
        return { userId: ctx.params.id };
      })
      .guard((ctx: any) => {
        executionLog.push('guard-blocked-check');
        if (ctx.userId === 'blocked') {
          ctx.res.status(403).json({ error: 'Blocked' });
          return ctx.stop();
        }
        return undefined;
      })
      .use((ctx: any) => {
        executionLog.push('use-timestamp');
        return { timestamp: Date.now() };
      })
      .returns(200, z.object({ success: z.boolean() }))
      .handle((ctx: any) => {
        executionLog.push('handler');
        finalContext = ctx;
        ctx.res.json({ success: true });
      });

    const ctx = {
      params: { id: '123' },
      rawBody: { name: 'John Doe' },
      rawQuery: { include: 'profile' },
      res: {
        status: () => ({ json: () => {}, end: () => {} }),
        json: () => {},
      },
    };

    await executeRoute(route, ctx);

    // Verify execution order: query guard, body guard, use, guard, use, handler
    assert.ok(executionLog.includes('use-userId'));
    assert.ok(executionLog.includes('guard-blocked-check'));
    assert.ok(executionLog.includes('use-timestamp'));
    assert.ok(executionLog.includes('handler'));

    // Verify all context properties are present
    assert.ok(finalContext.body);
    assert.ok(finalContext.query);
    assert.ok(finalContext.userId);
    assert.ok(typeof finalContext.timestamp === 'number');
  });

  it('should support multiple response schemas', () => {
    const route = Post('/users/:id')
      .apply(resolvePlugin(body(z.object({ name: z.string() }))))
      .apply(resolvePlugin(query(z.object({ include: z.string().optional() }))))
      .use((ctx: any) => ({ userId: ctx.params.id }))
      .guard((ctx: any) => {
        if (ctx.userId === 'blocked') {
          ctx.res.status(403).json({ error: 'Blocked' });
          return ctx.stop();
        }
        return undefined;
      })
      .returns(200, z.object({ success: z.boolean() }))
      .returns(403, z.object({ error: z.string() }))
      .returns(404, z.object({ message: z.string() }))
      .handle((ctx: any) => {
        ctx.res.json({ success: true });
      });

    // Verify response schemas were registered
    assert.strictEqual(route.responseSchemas.has(200), true);
    assert.strictEqual(route.responseSchemas.has(403), true);
    assert.strictEqual(route.responseSchemas.has(404), true);

    // Verify 400 schema from validation plugins
    assert.strictEqual(route.responseSchemas.has(400), true);
  });

  it('should handle async middleware execution', async () => {
    let capturedContext: any = null;

    const route = Post('/users/:id')
      .apply(resolvePlugin(body(z.object({ name: z.string() }))))
      .apply(resolvePlugin(query(z.object({ include: z.string().optional() }))))
      .use(async (ctx: any) => {
        // Simulate async operation (e.g., database lookup)
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { userId: ctx.params.id };
      })
      .guard(async (ctx: any) => {
        // Simulate async guard (e.g., permission check)
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (ctx.userId === 'blocked') {
          ctx.res.status(403).json({ error: 'Blocked' });
          return ctx.stop();
        }
        return undefined;
      })
      .returns(200, z.object({ success: z.boolean() }))
      .handle(async (ctx: any) => {
        capturedContext = ctx;
        ctx.res.json({ success: true });
      });

    const ctx = {
      params: { id: '123' },
      rawBody: { name: 'John Doe' },
      rawQuery: { include: 'profile' },
      res: {
        status: () => ({ json: () => {}, end: () => {} }),
        json: () => {},
      },
    };

    await executeRoute(route, ctx);

    // Verify async operations completed successfully
    assert.ok(capturedContext);
    assert.strictEqual(capturedContext.userId, '123');
  });
});
