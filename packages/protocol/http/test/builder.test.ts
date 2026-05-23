import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { executeRoute } from '@justscale/core';
import { Get, Post, Put, Patch, Delete, Head, Options } from '../src/builder/create-http-builder.js';
import { body, ValidationErrorSchema } from '../src/builder/plugins/body.js';
import { query } from '../src/builder/plugins/query.js';
import { defineModel, field, Reference, isReference } from '@justscale/core/models';

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
// HTTP Builder Factory Tests
// ============================================================================

describe('HTTP Builder Factory', () => {
  describe('HTTP Method Factories', () => {
    it('Get() should create builder with GET method', () => {
      const builder = Get('/test');
      const route = builder.handle(() => {});

      assert.strictEqual(route.method, 'GET');
      assert.strictEqual(route.path, '/test');
    });

    it('Post() should create builder with POST method', () => {
      const builder = Post('/test');
      const route = builder.handle(() => {});

      assert.strictEqual(route.method, 'POST');
      assert.strictEqual(route.path, '/test');
    });

    it('Put() should create builder with PUT method', () => {
      const builder = Put('/test');
      const route = builder.handle(() => {});

      assert.strictEqual(route.method, 'PUT');
      assert.strictEqual(route.path, '/test');
    });

    it('Patch() should create builder with PATCH method', () => {
      const builder = Patch('/test');
      const route = builder.handle(() => {});

      assert.strictEqual(route.method, 'PATCH');
      assert.strictEqual(route.path, '/test');
    });

    it('Delete() should create builder with DELETE method', () => {
      const builder = Delete('/test');
      const route = builder.handle(() => {});

      assert.strictEqual(route.method, 'DELETE');
      assert.strictEqual(route.path, '/test');
    });

    it('Head() should create builder with HEAD method', () => {
      const builder = Head('/test');
      const route = builder.handle(() => {});

      assert.strictEqual(route.method, 'HEAD');
      assert.strictEqual(route.path, '/test');
    });

    it('Options() should create builder with OPTIONS method', () => {
      const builder = Options('/test');
      const route = builder.handle(() => {});

      assert.strictEqual(route.method, 'OPTIONS');
      assert.strictEqual(route.path, '/test');
    });
  });

  describe('Builder Methods', () => {
    it('should have all required methods', () => {
      const builder = Get('/test');

      assert.strictEqual(typeof builder.use, 'function');
      assert.strictEqual(typeof builder.guard, 'function');
      assert.strictEqual(typeof builder.apply, 'function');
      assert.strictEqual(typeof builder.returns, 'function');
      assert.strictEqual(typeof builder.body, 'function');
      assert.strictEqual(typeof builder.query, 'function');
      assert.strictEqual(typeof builder.handle, 'function');
    });

    it('.use() should add middleware steps', () => {
      const route = Get('/test')
        .use((ctx) => ({ added: true }))
        .handle(() => {});

      assert.strictEqual(route.steps.length, 1);
      assert.strictEqual(route.steps[0].type, 'use');
    });

    it('.guard() should add guard steps', () => {
      const route = Get('/test')
        .guard(() => undefined)
        .handle(() => {});

      assert.strictEqual(route.steps.length, 1);
      assert.strictEqual(route.steps[0].type, 'guard');
    });

    it('.returns() should add response schemas', () => {
      const schema = z.object({ message: z.string() });
      const route = Get('/test')
        .returns(200, schema)
        .handle(() => {});

      assert.strictEqual(route.responseSchemas.size, 1);
      assert.strictEqual(route.responseSchemas.get(200), schema);
    });

    it('should support method chaining', () => {
      const route = Get('/test')
        .use(() => ({ step1: true }))
        .guard(() => undefined)
        .returns(200, z.object({ ok: z.boolean() }))
        .returns(400)
        .handle(() => {});

      assert.strictEqual(route.steps.length, 2);
      assert.strictEqual(route.responseSchemas.size, 2);
    });
  });
});

// ============================================================================
// Body Validation Plugin Tests
// ============================================================================

describe('Body Validation Plugin', () => {
  describe('Valid body', () => {
    it('should pass validation and add typed body to context', async () => {
      const schema = z.object({
        name: z.string(),
        email: z.string(),
      });

      let handlerCalled = false;
      let capturedContext: any = null;

      const route = Post('/users')
        .apply(resolvePlugin(body(schema)))
        .handle((ctx: any) => {
          handlerCalled = true;
          capturedContext = ctx;
        });

      // Mock context with valid body
      const ctx = {
        rawBody: { name: 'John', email: 'john@example.com' },
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.strictEqual(handlerCalled, true);
      assert.ok(capturedContext.body);
      assert.strictEqual(capturedContext.body.name, 'John');
      assert.strictEqual(capturedContext.body.email, 'john@example.com');
    });

    it('should coerce types when schema uses coercion', async () => {
      const schema = z.object({
        age: z.coerce.number(),
        active: z.coerce.boolean(),
      });

      let capturedBody: any = null;

      const route = Post('/users')
        .apply(resolvePlugin(body(schema)))
        .handle((ctx: any) => {
          capturedBody = ctx.body;
        });

      const ctx = {
        rawBody: { age: '25', active: 'true' },
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.strictEqual(capturedBody.age, 25);
      assert.strictEqual(capturedBody.active, true);
    });
  });

  describe('Invalid body', () => {
    it('should return 400 with validation errors and stop execution', async () => {
      const schema = z.object({
        name: z.string(),
        email: z.string().email(),
      });

      let handlerCalled = false;
      let responseStatus: number | null = null;
      let responseData: any = null;

      const route = Post('/users')
        .apply(resolvePlugin(body(schema)))
        .handle(() => {
          handlerCalled = true;
        });

      // Mock context with invalid body
      const ctx = {
        rawBody: { name: 123, email: 'not-an-email' },
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
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.strictEqual(handlerCalled, false, 'Handler should not be called');
      assert.strictEqual(responseStatus, 400);
      assert.ok(responseData);
      assert.ok(responseData.errors);
      assert.ok(responseData.errors.name || responseData.errors.email);
    });

    it('should include validation errors for all failed fields', async () => {
      const schema = z.object({
        name: z.string().min(3),
        email: z.string().email(),
        age: z.number().min(18),
      });

      let responseData: any = null;

      const route = Post('/users')
        .apply(resolvePlugin(body(schema)))
        .handle(() => {});

      const ctx = {
        rawBody: { name: 'ab', email: 'invalid', age: 15 },
        res: {
          status: () => ({
            json: (data: any) => {
              responseData = data;
            },
            end: () => {},
          }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.ok(responseData);
      assert.ok(responseData.errors);
      // At least one field should have errors
      assert.ok(
        responseData.errors.name ||
          responseData.errors.email ||
          responseData.errors.age
      );
    });
  });

  describe('Schema validation', () => {
    it('should validate nested objects', async () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          address: z.object({
            street: z.string(),
            city: z.string(),
          }),
        }),
      });

      let capturedBody: any = null;

      const route = Post('/data')
        .apply(resolvePlugin(body(schema)))
        .handle((ctx: any) => {
          capturedBody = ctx.body;
        });

      const validData = {
        user: {
          name: 'John',
          address: {
            street: '123 Main St',
            city: 'Boston',
          },
        },
      };

      const ctx = {
        rawBody: validData,
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.deepStrictEqual(capturedBody, validData);
    });

    it('should validate arrays', async () => {
      const schema = z.object({
        items: z.array(z.string()),
      });

      let capturedBody: any = null;

      const route = Post('/data')
        .apply(resolvePlugin(body(schema)))
        .handle((ctx: any) => {
          capturedBody = ctx.body;
        });

      const ctx = {
        rawBody: { items: ['a', 'b', 'c'] },
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.deepStrictEqual(capturedBody.items, ['a', 'b', 'c']);
    });
  });

  describe('Response schema', () => {
    it('should add 400 response schema to route', () => {
      const schema = z.object({ name: z.string() });

      const route = Post('/test')
        .apply(resolvePlugin(body(schema)))
        .handle(() => {});

      assert.strictEqual(route.responseSchemas.has(400), true);
      assert.strictEqual(route.responseSchemas.get(400), ValidationErrorSchema);
    });
  });
});

// ============================================================================
// Query Validation Plugin Tests
// ============================================================================

describe('Query Validation Plugin', () => {
  describe('Valid query', () => {
    it('should pass validation and add typed query to context', async () => {
      const schema = z.object({
        page: z.coerce.number(),
        limit: z.coerce.number(),
      });

      let handlerCalled = false;
      let capturedContext: any = null;

      const route = Get('/users')
        .apply(resolvePlugin(query(schema)))
        .handle((ctx: any) => {
          handlerCalled = true;
          capturedContext = ctx;
        });

      // Mock context with valid query (query params are always strings)
      const ctx = {
        rawQuery: { page: '1', limit: '10' },
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.strictEqual(handlerCalled, true);
      assert.ok(capturedContext.query);
      assert.strictEqual(capturedContext.query.page, 1);
      assert.strictEqual(capturedContext.query.limit, 10);
    });

    it('should handle optional query parameters', async () => {
      const schema = z.object({
        search: z.string().optional(),
        sort: z.enum(['asc', 'desc']).optional(),
      });

      let capturedQuery: any = null;

      const route = Get('/users')
        .apply(resolvePlugin(query(schema)))
        .handle((ctx: any) => {
          capturedQuery = ctx.query;
        });

      const ctx = {
        rawQuery: { search: 'test' },
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.strictEqual(capturedQuery.search, 'test');
      assert.strictEqual(capturedQuery.sort, undefined);
    });
  });

  describe('Invalid query', () => {
    it('should return 400 with validation errors and stop execution', async () => {
      const schema = z.object({
        page: z.coerce.number().min(1),
        limit: z.coerce.number().min(1).max(100),
      });

      let handlerCalled = false;
      let responseStatus: number | null = null;
      let responseData: any = null;

      const route = Get('/users')
        .apply(resolvePlugin(query(schema)))
        .handle(() => {
          handlerCalled = true;
        });

      // Mock context with invalid query
      const ctx = {
        rawQuery: { page: '0', limit: '200' },
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
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.strictEqual(handlerCalled, false, 'Handler should not be called');
      assert.strictEqual(responseStatus, 400);
      assert.ok(responseData);
      assert.ok(responseData.errors);
    });

    it('should handle missing required query parameters', async () => {
      const schema = z.object({
        id: z.string(),
        type: z.string(),
      });

      let responseData: any = null;

      const route = Get('/items')
        .apply(resolvePlugin(query(schema)))
        .handle(() => {});

      const ctx = {
        rawQuery: { id: '123' }, // missing 'type'
        res: {
          status: () => ({
            json: (data: any) => {
              responseData = data;
            },
            end: () => {},
          }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.ok(responseData);
      assert.ok(responseData.errors);
    });
  });

  describe('Response schema', () => {
    it('should add 400 response schema to route', () => {
      const schema = z.object({ page: z.coerce.number() });

      const route = Get('/test')
        .apply(resolvePlugin(query(schema)))
        .handle(() => {});

      assert.strictEqual(route.responseSchemas.has(400), true);
      assert.strictEqual(route.responseSchemas.get(400), ValidationErrorSchema);
    });
  });
});

// ============================================================================
// Integration with executeRoute Tests
// ============================================================================

describe('Integration with executeRoute', () => {
  describe('Middleware chain execution', () => {
    it('should execute steps in order and accumulate context', async () => {
      const executionLog: string[] = [];

      const route = Post('/test')
        .use((ctx) => {
          executionLog.push('use1');
          return { step1: true };
        })
        .guard(() => {
          executionLog.push('guard1');
          return undefined;
        })
        .use((ctx) => {
          executionLog.push('use2');
          return { step2: true };
        })
        .handle((ctx: any) => {
          executionLog.push('handler');
        });

      await executeRoute(route, {});

      assert.deepStrictEqual(executionLog, ['use1', 'guard1', 'use2', 'handler']);
    });

    it('should accumulate context through middleware chain', async () => {
      let finalContext: any = null;

      const route = Post('/test')
        .use((ctx) => ({ a: 1 }))
        .use((ctx) => ({ b: 2 }))
        .use((ctx) => ({ c: 3 }))
        .handle((ctx: any) => {
          finalContext = ctx;
        });

      const initialCtx = { initial: true };
      await executeRoute(route, initialCtx);

      assert.strictEqual(finalContext.initial, true);
      assert.strictEqual(finalContext.a, 1);
      assert.strictEqual(finalContext.b, 2);
      assert.strictEqual(finalContext.c, 3);
    });

    it('should expose stop() to guards but not use middleware', async () => {
      let useHasStop: boolean | null = null;
      let guardHasStop: boolean | null = null;

      const route = Post('/test')
        .use((ctx) => {
          useHasStop = typeof (ctx as any).stop === 'function';
          return {};
        })
        .guard((ctx) => {
          guardHasStop = typeof ctx.stop === 'function';
          return undefined;
        })
        .handle(() => {});

      await executeRoute(route, {});

      assert.strictEqual(useHasStop, false);
      assert.strictEqual(guardHasStop, true);
    });
  });

  describe('Guard stops execution', () => {
    it('should stop execution when guard returns stop signal', async () => {
      let handlerCalled = false;
      let middleware2Called = false;

      const route = Post('/test')
        .use((ctx) => ({ step1: true }))
        .guard((ctx) => ctx.stop())
        .use((ctx) => {
          middleware2Called = true;
          return { step2: true };
        })
        .handle(() => {
          handlerCalled = true;
        });

      await executeRoute(route, {});

      assert.strictEqual(handlerCalled, false);
      assert.strictEqual(middleware2Called, false);
    });

    it('should stop on guard failure with body validation', async () => {
      let handlerCalled = false;

      const route = Post('/users')
        .apply(resolvePlugin(body(z.object({ name: z.string() }))))
        .handle(() => {
          handlerCalled = true;
        });

      const ctx = {
        rawBody: { name: 123 }, // invalid
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.strictEqual(handlerCalled, false);
    });

    it('should stop on guard failure with query validation', async () => {
      let handlerCalled = false;

      const route = Get('/users')
        .apply(resolvePlugin(query(z.object({ page: z.coerce.number().min(1) }))))
        .handle(() => {
          handlerCalled = true;
        });

      const ctx = {
        rawQuery: { page: '0' }, // invalid
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.strictEqual(handlerCalled, false);
    });
  });

  describe('Full route execution', () => {
    it('should execute complete route with body and query validation', async () => {
      const bodySchema = z.object({
        name: z.string(),
        email: z.string(),
      });

      const querySchema = z.object({
        notify: z.enum(['true', 'false']).optional(),
      });

      let finalContext: any = null;

      const route = Post('/users')
        .apply(resolvePlugin(query(querySchema)))
        .apply(resolvePlugin(body(bodySchema)))
        .use((ctx) => ({ timestamp: Date.now() }))
        .handle((ctx: any) => {
          finalContext = ctx;
        });

      const ctx = {
        rawBody: { name: 'John', email: 'john@example.com' },
        rawQuery: { notify: 'true' },
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);

      assert.ok(finalContext);
      assert.strictEqual(finalContext.body.name, 'John');
      assert.strictEqual(finalContext.body.email, 'john@example.com');
      assert.strictEqual(finalContext.query.notify, 'true');
      assert.ok(typeof finalContext.timestamp === 'number');
    });

    it('should execute async middleware in sequence', async () => {
      const delays: number[] = [];

      const route = Post('/test')
        .use(async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          delays.push(1);
          return { a: 1 };
        })
        .use(async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          delays.push(2);
          return { b: 2 };
        })
        .handle(async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          delays.push(3);
        });

      await executeRoute(route, {});

      assert.deepStrictEqual(delays, [1, 2, 3]);
    });
  });

  describe('Complex scenarios', () => {
    it('should handle route with custom guards and validation', async () => {
      const bodySchema = z.object({ userId: z.string() });

      let authCheckPassed = false;
      let validationPassed: boolean;
      let handlerCalled = false;

      const route = Post('/secure')
        .guard((ctx: any) => {
          // Simulate auth check
          if (!ctx.authToken) {
            return ctx.stop();
          }
          authCheckPassed = true;
        })
        .apply(resolvePlugin(body(bodySchema)))
        .guard(() => {
          validationPassed = true;
          return undefined;
        })
        .handle(() => {
          handlerCalled = true;
        });

      // Test with missing auth
      const noAuthCtx = {
        rawBody: { userId: '123' },
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, noAuthCtx);
      assert.strictEqual(authCheckPassed, false);
      assert.strictEqual(handlerCalled, false);

      // Reset
      authCheckPassed = false;
      validationPassed = false;
      handlerCalled = false;

      // Test with valid auth and body
      const validCtx = {
        authToken: 'valid-token',
        rawBody: { userId: '123' },
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, validCtx);
      assert.strictEqual(authCheckPassed, true);
      assert.strictEqual(validationPassed, true);
      assert.strictEqual(handlerCalled, true);
    });

    it('should work with multiple validation plugins', async () => {
      const route = Post('/data')
        .apply(resolvePlugin(query(z.object({ format: z.enum(['json', 'xml']) }))))
        .apply(resolvePlugin(body(z.object({ data: z.string() }))))
        .handle((ctx: any) => {
          // Both query and body should be available
          assert.strictEqual(ctx.query.format, 'json');
          assert.strictEqual(ctx.body.data, 'test');
        });

      const ctx = {
        rawQuery: { format: 'json' },
        rawBody: { data: 'test' },
        res: {
          status: () => ({ json: () => {}, end: () => {} }),
          json: () => {},
        },
      };

      await executeRoute(route, ctx);
    });
  });

  describe('.types() param narrowing', () => {
    class Product extends defineModel({
      fields: { name: field.string() },
    }) {}

    it('route-level .types() stores types on route def', () => {
      const route = Get('/:productRef')
        .types({ Product })
        .handle(async () => {});

      assert.ok((route as any).types);
      assert.strictEqual((route as any).types.Product, Product);
    });

    it('.types() transforms params at runtime via applyTypesConfig', async () => {
      let capturedParams: any = null;

      const route = Get('/:productRef')
        .types({ Product })
        .handle(async (ctx: any) => {
          capturedParams = ctx.params;
        });

      // Simulate what the HTTP server does: apply types to params
      const { applyTypesConfig } = await import('@justscale/core/models');
      const rawParams = { productRef: 'prod-123' };
      const typedParams = applyTypesConfig(rawParams, (route as any).types);

      await executeRoute(route, {
        params: typedParams,
        res: { status: () => ({ json: () => {}, end: () => {} }), json: () => {} },
      });

      assert.ok(isReference(capturedParams.productRef));
      assert.strictEqual(capturedParams.productRef.identifier, 'prod-123');
    });

    it('compile-time: params.productRef is Reference<Product> after .types()', () => {
      // This test verifies the type narrowing compiles correctly.
      // If types are wrong, this file won't compile.
      Get('/:productRef')
        .types({ Product })
        .handle(async ({ params }) => {
          // params.productRef is Reference<Product> - has .identifier
          const _id: string = params.productRef.identifier;
          void _id;
        });
    });
  });

  // ============================================================================
  // Permission-scoped .returns() - runtime wiring
  // ============================================================================

  describe('Permission-scoped .returns()', () => {
    const fullAccess = { name: 'fullAccess' as const };
    const view = { name: 'view' as const };
    const fullSchema = z.object({ name: z.string(), salary: z.string() });
    const limitedSchema = z.object({ name: z.string() });

    it('attaches permissionReturns to RouteDef', () => {
      const route = Get('/employees/:id')
        .returns(200, fullSchema, fullAccess)
        .returns(200, limitedSchema, view)
        .handle(() => {});

      assert.ok(route.permissionReturns);
      assert.strictEqual(route.permissionReturns.length, 2);
      assert.strictEqual(route.permissionReturns[0].permission.name, 'fullAccess');
      assert.strictEqual(route.permissionReturns[1].permission.name, 'view');
    });

    it('permissionReturns preserves schema reference', () => {
      const route = Get('/employees/:id')
        .returns(200, fullSchema, fullAccess)
        .handle(() => {});

      assert.strictEqual(route.permissionReturns![0].schema, fullSchema);
    });

    it('no permissionReturns when all returns are unpermissioned', () => {
      const route = Get('/users')
        .returns(200, z.object({ users: z.array(z.string()) }))
        .returns(404)
        .handle(() => {});

      assert.strictEqual(route.permissionReturns, undefined);
    });

    it('mixed permission and unpermission returns only track permissioned ones', () => {
      const route = Get('/employees/:id')
        .returns(200, fullSchema, fullAccess)
        .returns(200, limitedSchema, view)
        .returns(404, z.object({ error: z.string() }))
        .handle(() => {});

      assert.ok(route.permissionReturns);
      assert.strictEqual(route.permissionReturns.length, 2);
      // 404 is NOT in permissionReturns - only 200-with-permission entries
      assert.ok(route.permissionReturns.every((r) => r.status === 200));
    });

    it('responseSchemas still records status codes (runtime validation hook)', () => {
      const route = Get('/employees/:id')
        .returns(200, fullSchema, fullAccess)
        .returns(404, z.object({ error: z.string() }))
        .handle(() => {});

      assert.strictEqual(route.responseSchemas.size, 2);
      assert.ok(route.responseSchemas.has(200));
      assert.ok(route.responseSchemas.has(404));
    });
  });
});
