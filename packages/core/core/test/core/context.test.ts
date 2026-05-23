/**
 * Unit tests for the Request Context System
 *
 * Tests the AsyncLocalStorage-based context propagation for:
 * - DI Container access from anywhere in the async tree
 * - Request chain tracing across entry points
 * - Full request scope combining container + request context + observability
 *
 * Test Coverage:
 * - getContainer() / requireContainer() / runWithContainer()
 * - getRequestContext() / getRequestChain() / runWithRequestContext()
 * - runInFullRequestScope() / runInFullRequestScopeSync()
 * - Nested context scenarios
 * - Async propagation through promises
 * - Context isolation between concurrent requests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getContainer,
  requireContainer,
  runWithContainer,
  getRequestContext,
  getRequestChain,
  runWithRequestContext,
  runInFullRequestScope,
  runInFullRequestScopeSync,
  type RequestContext,
  type RequestType,
} from '../../src/core/context.js';
import { Container } from '../../src/core/service.js';

// ============================================================================
// Container Context Tests
// ============================================================================

describe('Container Context', () => {
  describe('getContainer()', () => {
    it('should return undefined outside of context', () => {
      const container = getContainer();
      assert.strictEqual(container, undefined);
    });

    it('should return container inside runWithContainer', () => {
      const testContainer = new Container();
      runWithContainer(testContainer, () => {
        const container = getContainer();
        assert.strictEqual(container, testContainer);
      });
    });

    it('should propagate through nested function calls', () => {
      const testContainer = new Container();

      function innerFunction() {
        return getContainer();
      }

      function middleFunction() {
        return innerFunction();
      }

      runWithContainer(testContainer, () => {
        const container = middleFunction();
        assert.strictEqual(container, testContainer);
      });
    });

    it('should propagate through async functions', async () => {
      const testContainer = new Container();

      async function asyncInner(): Promise<Container | undefined> {
        await Promise.resolve();
        return getContainer();
      }

      await runWithContainer(testContainer, async () => {
        const container = await asyncInner();
        assert.strictEqual(container, testContainer);
      });
    });

    it('should propagate through Promise.all', async () => {
      const testContainer = new Container();

      await runWithContainer(testContainer, async () => {
        const results = await Promise.all([
          Promise.resolve().then(() => getContainer()),
          Promise.resolve().then(() => getContainer()),
          Promise.resolve().then(() => getContainer()),
        ]);

        assert.strictEqual(results.length, 3);
        for (const container of results) {
          assert.strictEqual(container, testContainer);
        }
      });
    });

    it('should propagate through setTimeout callbacks', async () => {
      const testContainer = new Container();

      await runWithContainer(testContainer, async () => {
        const container = await new Promise<Container | undefined>((resolve) => {
          setTimeout(() => {
            resolve(getContainer());
          }, 10);
        });

        assert.strictEqual(container, testContainer);
      });
    });
  });

  describe('requireContainer()', () => {
    it('should throw when no container in context', () => {
      assert.throws(
        () => requireContainer(),
        {
          message: 'No container in context. Ensure code runs within request scope.',
        }
      );
    });

    it('should return container when in context', () => {
      const testContainer = new Container();
      runWithContainer(testContainer, () => {
        const container = requireContainer();
        assert.strictEqual(container, testContainer);
      });
    });
  });

  describe('runWithContainer()', () => {
    it('should return synchronous result', () => {
      const testContainer = new Container();
      const result = runWithContainer(testContainer, () => {
        return 'test-result';
      });
      assert.strictEqual(result, 'test-result');
    });

    it('should return async result', async () => {
      const testContainer = new Container();
      const result = await runWithContainer(testContainer, async () => {
        await Promise.resolve();
        return 'async-result';
      });
      assert.strictEqual(result, 'async-result');
    });

    it('should propagate errors', () => {
      const testContainer = new Container();
      assert.throws(
        () => runWithContainer(testContainer, () => {
          throw new Error('test error');
        }),
        { message: 'test error' }
      );
    });

    it('should restore context after nested runWithContainer', () => {
      const outerContainer = new Container();
      const innerContainer = new Container();

      runWithContainer(outerContainer, () => {
        assert.strictEqual(getContainer(), outerContainer);

        runWithContainer(innerContainer, () => {
          assert.strictEqual(getContainer(), innerContainer);
        });

        // Should restore outer container
        assert.strictEqual(getContainer(), outerContainer);
      });
    });

    it('should isolate context between concurrent executions', async () => {
      const container1 = new Container();
      const container2 = new Container();

      const results: Array<{ id: number; container: Container | undefined }> = [];

      await Promise.all([
        runWithContainer(container1, async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          results.push({ id: 1, container: getContainer() });
        }),
        runWithContainer(container2, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push({ id: 2, container: getContainer() });
        }),
      ]);

      // Results should be isolated
      const result1 = results.find((r) => r.id === 1);
      const result2 = results.find((r) => r.id === 2);

      assert.strictEqual(result1?.container, container1);
      assert.strictEqual(result2?.container, container2);
    });
  });
});

// ============================================================================
// Request Context Tests
// ============================================================================

describe('Request Context', () => {
  describe('getRequestContext()', () => {
    it('should return undefined outside of context', () => {
      const ctx = getRequestContext();
      assert.strictEqual(ctx, undefined);
    });

    it('should return context inside runWithRequestContext', () => {
      runWithRequestContext('http', 'GET /test', () => {
        const ctx = getRequestContext();
        assert.ok(ctx);
        assert.strictEqual(ctx.type, 'http');
        assert.strictEqual(ctx.name, 'GET /test');
      });
    });

    it('should generate unique request IDs', () => {
      const ids: string[] = [];

      for (let i = 0; i < 10; i++) {
        runWithRequestContext('http', 'test', () => {
          const ctx = getRequestContext()!;
          ids.push(ctx.id);
        });
      }

      // All IDs should be unique
      const uniqueIds = new Set(ids);
      assert.strictEqual(uniqueIds.size, ids.length);
    });

    it('should include startedAt timestamp', () => {
      const before = new Date();

      runWithRequestContext('http', 'test', () => {
        const ctx = getRequestContext()!;
        assert.ok(ctx.startedAt instanceof Date);
        assert.ok(ctx.startedAt >= before);
      });
    });

    it('should include metadata when provided', () => {
      runWithRequestContext('http', 'POST /users', () => {
        // No metadata
        const ctx = getRequestContext()!;
        assert.strictEqual(ctx.metadata, undefined);
      }, undefined);

      runWithRequestContext('http', 'POST /users', () => {
        // With metadata
        const ctx = getRequestContext()!;
        assert.deepStrictEqual(ctx.metadata, { userId: '123', action: 'create' });
      }, { userId: '123', action: 'create' });
    });
  });

  describe('runWithRequestContext()', () => {
    it('should support all request types', () => {
      const types: RequestType[] = ['http', 'ws', 'cli', 'event', 'process', 'scheduled', 'internal'];

      for (const type of types) {
        runWithRequestContext(type, `test-${type}`, () => {
          const ctx = getRequestContext()!;
          assert.strictEqual(ctx.type, type);
        });
      }
    });

    it('should return synchronous result', () => {
      const result = runWithRequestContext('http', 'test', () => {
        return { value: 42 };
      });
      assert.deepStrictEqual(result, { value: 42 });
    });

    it('should return async result', async () => {
      const result = await runWithRequestContext('http', 'test', async () => {
        await Promise.resolve();
        return { value: 'async' };
      });
      assert.deepStrictEqual(result, { value: 'async' });
    });

    it('should propagate through async boundaries', async () => {
      await runWithRequestContext('http', 'test', async () => {
        const ctxBefore = getRequestContext();

        await new Promise((resolve) => setTimeout(resolve, 10));

        const ctxAfter = getRequestContext();

        assert.ok(ctxBefore);
        assert.ok(ctxAfter);
        assert.strictEqual(ctxBefore.id, ctxAfter.id);
      });
    });

    it('should link parent context in nested calls', () => {
      runWithRequestContext('http', 'HTTP request', () => {
        const parentCtx = getRequestContext()!;

        runWithRequestContext('event', 'user.created', () => {
          const childCtx = getRequestContext()!;

          assert.strictEqual(childCtx.parent, parentCtx);
          assert.strictEqual(childCtx.parent?.type, 'http');
          assert.strictEqual(childCtx.parent?.name, 'HTTP request');
        });
      });
    });
  });

  describe('getRequestChain()', () => {
    it('should return empty array outside of context', () => {
      const chain = getRequestChain();
      assert.deepStrictEqual(chain, []);
    });

    it('should return single element for single context', () => {
      runWithRequestContext('http', 'GET /users', () => {
        const chain = getRequestChain();
        assert.strictEqual(chain.length, 1);
        assert.strictEqual(chain[0].type, 'http');
        assert.strictEqual(chain[0].name, 'GET /users');
      });
    });

    it('should build chain from nested contexts', () => {
      runWithRequestContext('http', 'POST /orders', () => {
        runWithRequestContext('event', 'order.created', () => {
          runWithRequestContext('process', 'fulfillment', () => {
            const chain = getRequestChain();

            assert.strictEqual(chain.length, 3);

            // Chain is from current to origin
            assert.strictEqual(chain[0].type, 'process');
            assert.strictEqual(chain[0].name, 'fulfillment');

            assert.strictEqual(chain[1].type, 'event');
            assert.strictEqual(chain[1].name, 'order.created');

            assert.strictEqual(chain[2].type, 'http');
            assert.strictEqual(chain[2].name, 'POST /orders');
          });
        });
      });
    });

    it('should preserve chain through async boundaries', async () => {
      await runWithRequestContext('http', 'origin', async () => {
        await runWithRequestContext('event', 'middle', async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));

          await runWithRequestContext('internal', 'deep', async () => {
            await Promise.resolve();

            const chain = getRequestChain();
            assert.strictEqual(chain.length, 3);
            assert.deepStrictEqual(
              chain.map((c) => c.type),
              ['internal', 'event', 'http']
            );
          });
        });
      });
    });

    it('should be useful for debugging trace output', () => {
      runWithRequestContext('http', 'POST /api/orders', () => {
        runWithRequestContext('event', 'order.created', () => {
          const chain = getRequestChain();
          const traceString = chain.map((c) => `${c.type}:${c.name}`).join(' → ');

          assert.strictEqual(
            traceString,
            'event:order.created → http:POST /api/orders'
          );
        });
      });
    });
  });
});

// ============================================================================
// Full Request Scope Tests
// ============================================================================

describe('runInFullRequestScope()', () => {
  it('should combine container and request context', async () => {
    const testContainer = new Container();

    await runInFullRequestScope(
      {
        container: testContainer,
        type: 'http',
        name: 'GET /test',
      },
      async () => {
        // Container should be available
        const container = getContainer();
        assert.strictEqual(container, testContainer);

        // Request context should be available
        const reqCtx = getRequestContext();
        assert.ok(reqCtx);
        assert.strictEqual(reqCtx.type, 'http');
        assert.strictEqual(reqCtx.name, 'GET /test');
      }
    );
  });

  it('should include metadata in request context', async () => {
    const testContainer = new Container();

    await runInFullRequestScope(
      {
        container: testContainer,
        type: 'http',
        name: 'POST /users',
        metadata: { userId: '123', ip: '127.0.0.1' },
      },
      async () => {
        const reqCtx = getRequestContext()!;
        assert.deepStrictEqual(reqCtx.metadata, { userId: '123', ip: '127.0.0.1' });
      }
    );
  });

  it('should return function result', async () => {
    const testContainer = new Container();

    const result = await runInFullRequestScope(
      {
        container: testContainer,
        type: 'http',
        name: 'test',
      },
      async () => {
        return { success: true, value: 42 };
      }
    );

    assert.deepStrictEqual(result, { success: true, value: 42 });
  });

  it('should propagate errors', async () => {
    const testContainer = new Container();

    await assert.rejects(
      () =>
        runInFullRequestScope(
          {
            container: testContainer,
            type: 'http',
            name: 'test',
          },
          async () => {
            throw new Error('intentional error');
          }
        ),
      { message: 'intentional error' }
    );
  });

  it('should maintain context through nested async operations', async () => {
    const testContainer = new Container();

    await runInFullRequestScope(
      {
        container: testContainer,
        type: 'http',
        name: 'outer',
      },
      async () => {
        // Simulate async work
        await Promise.resolve();

        // Nested request scope (e.g., event emission)
        await runInFullRequestScope(
          {
            container: testContainer,
            type: 'event',
            name: 'user.updated',
          },
          async () => {
            // Check container is still accessible
            assert.strictEqual(getContainer(), testContainer);

            // Check request chain
            const chain = getRequestChain();
            assert.strictEqual(chain.length, 2);
            assert.strictEqual(chain[0].type, 'event');
            assert.strictEqual(chain[1].type, 'http');
          }
        );

        // Original context should be restored
        const chain = getRequestChain();
        assert.strictEqual(chain.length, 1);
        assert.strictEqual(chain[0].type, 'http');
      }
    );
  });

  it('should isolate concurrent requests', async () => {
    const container1 = new Container();
    const container2 = new Container();

    const results: Array<{
      reqId: number
      containerMatch: boolean
      requestType: string
    }> = [];

    await Promise.all([
      runInFullRequestScope(
        { container: container1, type: 'http', name: 'request-1' },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          results.push({
            reqId: 1,
            containerMatch: getContainer() === container1,
            requestType: getRequestContext()!.type,
          });
        }
      ),
      runInFullRequestScope(
        { container: container2, type: 'ws', name: 'request-2' },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push({
            reqId: 2,
            containerMatch: getContainer() === container2,
            requestType: getRequestContext()!.type,
          });
        }
      ),
    ]);

    const result1 = results.find((r) => r.reqId === 1)!;
    const result2 = results.find((r) => r.reqId === 2)!;

    assert.strictEqual(result1.containerMatch, true);
    assert.strictEqual(result1.requestType, 'http');

    assert.strictEqual(result2.containerMatch, true);
    assert.strictEqual(result2.requestType, 'ws');
  });
});

describe('runInFullRequestScopeSync()', () => {
  it('should work for synchronous handlers', () => {
    const testContainer = new Container();

    const result = runInFullRequestScopeSync(
      {
        container: testContainer,
        type: 'cli',
        name: 'sync-command',
      },
      () => {
        const container = getContainer();
        const reqCtx = getRequestContext();

        return {
          hasContainer: container === testContainer,
          requestType: reqCtx?.type,
        };
      }
    );

    assert.deepStrictEqual(result, {
      hasContainer: true,
      requestType: 'cli',
    });
  });
});

// ============================================================================
// Edge Cases and Integration Tests
// ============================================================================

describe('Context Edge Cases', () => {
  it('should handle deeply nested contexts', async () => {
    const container = new Container();
    const depth = 10;

    async function recurse(level: number): Promise<number> {
      if (level === 0) {
        const chain = getRequestChain();
        return chain.length;
      }

      return runWithRequestContext('internal', `level-${level}`, async () => {
        return recurse(level - 1);
      });
    }

    const chainLength = await runInFullRequestScope(
      { container, type: 'http', name: 'start' },
      async () => recurse(depth)
    );

    assert.strictEqual(chainLength, depth + 1); // +1 for the initial http context
  });

  it('should maintain context across Promise chains', async () => {
    const container = new Container();

    await runInFullRequestScope(
      { container, type: 'http', name: 'promise-chain' },
      async () => {
        const results = await Promise.resolve()
          .then(() => getContainer())
          .then((c) => [c, getRequestContext()])
          .then(([c, r]) => ({
            container: c === container,
            hasRequest: r !== undefined,
          }));

        assert.strictEqual(results.container, true);
        assert.strictEqual(results.hasRequest, true);
      }
    );
  });

  it('should restore context after error in nested scope', () => {
    const outerContainer = new Container();
    const innerContainer = new Container();

    runWithContainer(outerContainer, () => {
      assert.strictEqual(getContainer(), outerContainer);

      try {
        runWithContainer(innerContainer, () => {
          assert.strictEqual(getContainer(), innerContainer);
          throw new Error('inner error');
        });
      } catch {
        // Expected
      }

      // Should restore outer container even after error
      assert.strictEqual(getContainer(), outerContainer);
    });
  });

  it('should handle queueMicrotask', async () => {
    const container = new Container();

    await runInFullRequestScope(
      { container, type: 'http', name: 'microtask-test' },
      async () => {
        const result = await new Promise<Container | undefined>((resolve) => {
          queueMicrotask(() => {
            resolve(getContainer());
          });
        });

        assert.strictEqual(result, container);
      }
    );
  });

  it('should handle setImmediate', async () => {
    const container = new Container();

    await runInFullRequestScope(
      { container, type: 'http', name: 'immediate-test' },
      async () => {
        const result = await new Promise<Container | undefined>((resolve) => {
          setImmediate(() => {
            resolve(getContainer());
          });
        });

        assert.strictEqual(result, container);
      }
    );
  });

  it('should work with for-await loops', async () => {
    const container = new Container();

    async function* asyncGenerator() {
      yield 1;
      yield 2;
      yield 3;
    }

    await runInFullRequestScope(
      { container, type: 'http', name: 'for-await-test' },
      async () => {
        const containers: Array<Container | undefined> = [];

        for await (const _ of asyncGenerator()) {
          containers.push(getContainer());
        }

        assert.strictEqual(containers.length, 3);
        for (const c of containers) {
          assert.strictEqual(c, container);
        }
      }
    );
  });

  it('should work with async iterators that yield promises', async () => {
    const container = new Container();

    await runInFullRequestScope(
      { container, type: 'ws', name: 'async-iter-test' },
      async () => {
        const values: number[] = [];

        // Simulate message processing
        const messages = [
          Promise.resolve(1),
          Promise.resolve(2),
          Promise.resolve(3),
        ];

        for (const msgPromise of messages) {
          const msg = await msgPromise;
          values.push(msg);

          // Context should be maintained
          assert.strictEqual(getContainer(), container);
          assert.strictEqual(getRequestContext()?.type, 'ws');
        }

        assert.deepStrictEqual(values, [1, 2, 3]);
      }
    );
  });
});

describe('Context with Real DI Container', () => {
  it('should resolve services within context', async () => {
    class TestService {
      getValue() {
        return 'test-value';
      }
    }

    const container = new Container();
    container.registerClass(TestService);

    await runInFullRequestScope(
      { container, type: 'http', name: 'di-test' },
      async () => {
        const currentContainer = requireContainer();
        const service = await currentContainer.resolve(TestService);

        assert.strictEqual(service.getValue(), 'test-value');
      }
    );
  });

  it('should allow service resolution in nested event handlers', async () => {
    class EventService {
      handle() {
        return 'handled';
      }
    }

    const container = new Container();
    container.registerClass(EventService);

    await runInFullRequestScope(
      { container, type: 'http', name: 'outer' },
      async () => {
        // Simulate emitting an event that needs to resolve services
        const result = await runWithRequestContext('event', 'user.created', async () => {
          const svc = await requireContainer().resolve(EventService);
          return svc.handle();
        });

        assert.strictEqual(result, 'handled');
      }
    );
  });
});
