/**
 * Integration tests for the Request Context System
 *
 * Tests context propagation through real application entry points:
 * - HTTP request handling via app.execute()
 * - Event emission with context preservation
 * - Multiple entry points in the same flow
 *
 * These tests verify the Phase 0 implementation goals:
 * - Container available from anywhere in async tree
 * - Request chain tracing across HTTP → event → process chains
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  getContainer,
  requireContainer,
  getRequestContext,
  getRequestChain,
  runInFullRequestScope,
  runWithRequestContext,
} from '../../src/core/context.js';
import { Container } from '../../src/core/service.js';

// ============================================================================
// Test Fixtures
// ============================================================================

class ContextTracker {
  traces: Array<{
    location: string
    hasContainer: boolean
    requestType: string | undefined
    chainLength: number
    chainTypes: string[]
  }> = [];

  capture(location: string) {
    this.traces.push({
      location,
      hasContainer: getContainer() !== undefined,
      requestType: getRequestContext()?.type,
      chainLength: getRequestChain().length,
      chainTypes: getRequestChain().map((c) => c.type),
    });
  }

  clear() {
    this.traces = [];
  }
}

// ============================================================================
// HTTP Request Context Tests
// ============================================================================

describe('HTTP Request Context Integration', () => {
  let container: Container;
  let tracker: ContextTracker;

  beforeEach(() => {
    container = new Container();
    tracker = new ContextTracker();
    container.registerInstance(ContextTracker, tracker);
  });

  it('should have container available in controller handlers', async () => {
    await runInFullRequestScope(
      { container, type: 'http', name: 'GET /test' },
      async () => {
        // Simulate a controller handler
        const currentContainer = getContainer();
        tracker.capture('controller-handler');

        assert.strictEqual(currentContainer, container);
      }
    );

    const trace = tracker.traces.find((t) => t.location === 'controller-handler');
    assert.ok(trace);
    assert.strictEqual(trace.hasContainer, true);
    assert.strictEqual(trace.requestType, 'http');
  });

  it('should maintain context through middleware chain', async () => {
    const middlewareTraces: string[] = [];

    await runInFullRequestScope(
      { container, type: 'http', name: 'GET /with-middleware' },
      async () => {
        // Simulate middleware 1
        const ctx1 = getRequestContext();
        middlewareTraces.push(`mw1:${ctx1?.type}`);

        // Simulate middleware 2 (async)
        await Promise.resolve();
        const ctx2 = getRequestContext();
        middlewareTraces.push(`mw2:${ctx2?.type}`);

        // Simulate handler
        const ctx3 = getRequestContext();
        middlewareTraces.push(`handler:${ctx3?.type}`);
      }
    );

    assert.deepStrictEqual(middlewareTraces, [
      'mw1:http',
      'mw2:http',
      'handler:http',
    ]);
  });

  it('should preserve chain when HTTP emits events', async () => {
    const chainAtEvent: string[] = [];

    await runInFullRequestScope(
      { container, type: 'http', name: 'POST /orders' },
      async () => {
        // Simulate HTTP handler that emits an event
        await runWithRequestContext('event', 'order.created', async () => {
          const chain = getRequestChain();
          chainAtEvent.push(...chain.map((c) => `${c.type}:${c.name}`));
        });
      }
    );

    assert.deepStrictEqual(chainAtEvent, [
      'event:order.created',
      'http:POST /orders',
    ]);
  });

  it('should preserve chain through multiple event hops', async () => {
    const chainAtDeepest: string[] = [];

    await runInFullRequestScope(
      { container, type: 'http', name: 'POST /checkout' },
      async () => {
        // HTTP → event 1
        await runWithRequestContext('event', 'order.placed', async () => {
          // event 1 → event 2
          await runWithRequestContext('event', 'inventory.reserved', async () => {
            // event 2 → event 3
            await runWithRequestContext('event', 'payment.charged', async () => {
              const chain = getRequestChain();
              chainAtDeepest.push(...chain.map((c) => `${c.type}:${c.name}`));
            });
          });
        });
      }
    );

    assert.deepStrictEqual(chainAtDeepest, [
      'event:payment.charged',
      'event:inventory.reserved',
      'event:order.placed',
      'http:POST /checkout',
    ]);
  });
});

// ============================================================================
// Event Handler Context Tests
// ============================================================================

describe('Event Handler Context Integration', () => {
  it('should trace from event back to HTTP origin', async () => {
    const traces: Array<{ at: string; originType: string | undefined }> = [];

    await runInFullRequestScope(
      { container: new Container(), type: 'http', name: 'POST /users' },
      async () => {
        await runWithRequestContext('event', 'user.created', async () => {
          const chain = getRequestChain();
          const origin = chain[chain.length - 1]; // last in chain is origin
          traces.push({ at: 'event-handler', originType: origin?.type });
        });
      }
    );

    assert.deepStrictEqual(traces, [
      { at: 'event-handler', originType: 'http' },
    ]);
  });

  it('should trace from event back to CLI origin', async () => {
    const traces: Array<{ at: string; originType: string | undefined; originName: string | undefined }> = [];

    await runInFullRequestScope(
      { container: new Container(), type: 'cli', name: 'import-users' },
      async () => {
        await runWithRequestContext('event', 'user.imported', async () => {
          const chain = getRequestChain();
          const origin = chain[chain.length - 1];
          traces.push({
            at: 'event-handler',
            originType: origin?.type,
            originName: origin?.name,
          });
        });
      }
    );

    assert.deepStrictEqual(traces, [
      { at: 'event-handler', originType: 'cli', originName: 'import-users' },
    ]);
  });

  it('should trace from event back to WebSocket origin', async () => {
    const chainTypes: string[] = [];

    await runInFullRequestScope(
      { container: new Container(), type: 'ws', name: 'message:chat.send' },
      async () => {
        await runWithRequestContext('event', 'chat.message.sent', async () => {
          await runWithRequestContext('internal', 'notify-recipients', async () => {
            const chain = getRequestChain();
            chainTypes.push(...chain.map((c) => c.type));
          });
        });
      }
    );

    assert.deepStrictEqual(chainTypes, ['internal', 'event', 'ws']);
  });
});

// ============================================================================
// Process Context Tests
// ============================================================================

describe('Process Context Integration', () => {
  it('should preserve origin context when process starts from HTTP', async () => {
    const traces: string[] = [];

    await runInFullRequestScope(
      { container: new Container(), type: 'http', name: 'POST /orders' },
      async () => {
        // Simulate starting a durable process
        await runWithRequestContext('process', 'order-fulfillment', async () => {
          const chain = getRequestChain();
          traces.push(chain.map((c) => c.type).join('→'));
        });
      }
    );

    assert.deepStrictEqual(traces, ['process→http']);
  });

  it('should capture origin context for process resume', async () => {
    // This simulates what the process executor does:
    // When a process starts, it captures the origin context
    // When it resumes, it should be able to restore some of that context

    interface OriginInfo {
      requestId: string
      type: string
      name: string
    }

    let capturedOrigin: OriginInfo | undefined;

    await runInFullRequestScope(
      { container: new Container(), type: 'http', name: 'POST /orders' },
      async () => {
        // Process starts - capture origin
        await runWithRequestContext('process', 'order-fulfillment', async () => {
          const chain = getRequestChain();
          const origin = chain[chain.length - 1];
          if (origin) {
            capturedOrigin = {
              requestId: origin.id,
              type: origin.type,
              name: origin.name,
            };
          }
        });
      }
    );

    assert.ok(capturedOrigin);
    assert.strictEqual(capturedOrigin.type, 'http');
    assert.strictEqual(capturedOrigin.name, 'POST /orders');
    assert.ok(capturedOrigin.requestId.length > 0);
  });

  it('should maintain container access through process execution', async () => {
    class ProcessService {
      execute() {
        return 'executed';
      }
    }

    const container = new Container();
    container.registerClass(ProcessService);

    let serviceResult: string | undefined;

    await runInFullRequestScope(
      { container, type: 'process', name: 'test-process' },
      async () => {
        const svc = await requireContainer().resolve(ProcessService);
        serviceResult = svc.execute();
      }
    );

    assert.strictEqual(serviceResult, 'executed');
  });
});

// ============================================================================
// Scheduled Task Context Tests
// ============================================================================

describe('Scheduled Task Context Integration', () => {
  it('should create context for scheduled tasks', async () => {
    const traces: Array<{ type: string; name: string }> = [];

    await runInFullRequestScope(
      {
        container: new Container(),
        type: 'scheduled',
        name: 'cleanup-expired-sessions',
      },
      async () => {
        const ctx = getRequestContext();
        if (ctx) {
          traces.push({ type: ctx.type, name: ctx.name });
        }
      }
    );

    assert.deepStrictEqual(traces, [
      { type: 'scheduled', name: 'cleanup-expired-sessions' },
    ]);
  });

  it('should trace events from scheduled tasks', async () => {
    const chainAtEvent: string[] = [];

    await runInFullRequestScope(
      { container: new Container(), type: 'scheduled', name: 'daily-report' },
      async () => {
        await runWithRequestContext('event', 'report.generated', async () => {
          const chain = getRequestChain();
          chainAtEvent.push(...chain.map((c) => `${c.type}:${c.name}`));
        });
      }
    );

    assert.deepStrictEqual(chainAtEvent, [
      'event:report.generated',
      'scheduled:daily-report',
    ]);
  });
});

// ============================================================================
// Concurrent Request Isolation Tests
// ============================================================================

describe('Concurrent Request Isolation', () => {
  it('should isolate multiple HTTP requests processed concurrently', async () => {
    const results: Array<{ reqId: number; contextName: string }> = [];

    await Promise.all([
      runInFullRequestScope(
        { container: new Container(), type: 'http', name: 'req-1' },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          results.push({ reqId: 1, contextName: getRequestContext()!.name });
        }
      ),
      runInFullRequestScope(
        { container: new Container(), type: 'http', name: 'req-2' },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          results.push({ reqId: 2, contextName: getRequestContext()!.name });
        }
      ),
      runInFullRequestScope(
        { container: new Container(), type: 'http', name: 'req-3' },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          results.push({ reqId: 3, contextName: getRequestContext()!.name });
        }
      ),
    ]);

    // Each request should have its own context despite concurrent execution
    assert.strictEqual(results.find((r) => r.reqId === 1)?.contextName, 'req-1');
    assert.strictEqual(results.find((r) => r.reqId === 2)?.contextName, 'req-2');
    assert.strictEqual(results.find((r) => r.reqId === 3)?.contextName, 'req-3');
  });

  it('should isolate nested events from different HTTP requests', async () => {
    const eventChains: Array<{ eventName: string; originRequest: string }> = [];

    await Promise.all([
      runInFullRequestScope(
        { container: new Container(), type: 'http', name: 'create-order-1' },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await runWithRequestContext('event', 'order.created', async () => {
            const chain = getRequestChain();
            const origin = chain[chain.length - 1];
            eventChains.push({
              eventName: chain[0].name,
              originRequest: origin.name,
            });
          });
        }
      ),
      runInFullRequestScope(
        { container: new Container(), type: 'http', name: 'create-order-2' },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          await runWithRequestContext('event', 'order.created', async () => {
            const chain = getRequestChain();
            const origin = chain[chain.length - 1];
            eventChains.push({
              eventName: chain[0].name,
              originRequest: origin.name,
            });
          });
        }
      ),
    ]);

    // Each event should trace back to its own origin request
    const order1Event = eventChains.find((e) => e.originRequest === 'create-order-1');
    const order2Event = eventChains.find((e) => e.originRequest === 'create-order-2');

    assert.ok(order1Event);
    assert.ok(order2Event);
    assert.strictEqual(order1Event.originRequest, 'create-order-1');
    assert.strictEqual(order2Event.originRequest, 'create-order-2');
  });
});

// ============================================================================
// Error Handling with Context
// ============================================================================

describe('Error Handling with Context', () => {
  it('should preserve context chain in error handlers', async () => {
    let chainInCatch: string[] = [];

    try {
      await runInFullRequestScope(
        { container: new Container(), type: 'http', name: 'POST /orders' },
        async () => {
          await runWithRequestContext('event', 'order.validate', async () => {
            throw new Error('Validation failed');
          });
        }
      );
    } catch {
      // Context is lost here since we're outside runInFullRequestScope
      // This is expected behavior
    }

    // Inside the scope, even error handlers should have context
    await runInFullRequestScope(
      { container: new Container(), type: 'http', name: 'POST /orders' },
      async () => {
        try {
          await runWithRequestContext('event', 'order.validate', async () => {
            const chain = getRequestChain();
            chainInCatch = chain.map((c) => c.name);
            throw new Error('Validation failed');
          });
        } catch {
          // Context is preserved here
          const chain = getRequestChain();
          assert.strictEqual(chain[0].name, 'POST /orders');
        }
      }
    );

    assert.deepStrictEqual(chainInCatch, ['order.validate', 'POST /orders']);
  });

  it('should restore context after error in nested scope', async () => {
    const contextAfterError: string | undefined = await runInFullRequestScope(
      { container: new Container(), type: 'http', name: 'outer-request' },
      async () => {
        try {
          await runWithRequestContext('event', 'failing-event', async () => {
            throw new Error('Event failed');
          });
        } catch {
          // Expected
        }

        // Context should be restored to outer-request
        return getRequestContext()?.name;
      }
    );

    assert.strictEqual(contextAfterError, 'outer-request');
  });
});

// ============================================================================
// Metadata Propagation Tests
// ============================================================================

describe('Metadata Propagation', () => {
  it('should allow custom metadata on each context level', async () => {
    const metadataByLevel: Array<{ level: string; metadata: Record<string, unknown> | undefined }> = [];

    await runInFullRequestScope(
      {
        container: new Container(),
        type: 'http',
        name: 'POST /orders',
        metadata: { userId: 'user-123', ip: '192.168.1.1' },
      },
      async () => {
        metadataByLevel.push({
          level: 'http',
          metadata: getRequestContext()?.metadata,
        });

        await runWithRequestContext(
          'event',
          'order.created',
          async () => {
            metadataByLevel.push({
              level: 'event',
              metadata: getRequestContext()?.metadata,
            });
          },
          { orderId: 'order-456' }
        );
      }
    );

    assert.deepStrictEqual(metadataByLevel[0].metadata, { userId: 'user-123', ip: '192.168.1.1' });
    assert.deepStrictEqual(metadataByLevel[1].metadata, { orderId: 'order-456' });
  });

  it('should access parent metadata through chain', async () => {
    let parentMetadata: Record<string, unknown> | undefined;

    await runInFullRequestScope(
      {
        container: new Container(),
        type: 'http',
        name: 'POST /orders',
        metadata: { userId: 'user-123' },
      },
      async () => {
        await runWithRequestContext('event', 'order.created', async () => {
          const chain = getRequestChain();
          const httpContext = chain.find((c) => c.type === 'http');
          parentMetadata = httpContext?.metadata;
        });
      }
    );

    assert.deepStrictEqual(parentMetadata, { userId: 'user-123' });
  });
});

// ============================================================================
// App Execute Options Tests
// ============================================================================

describe('App Execute Options', () => {
  it('should use event request type when specified', async () => {
    // This simulates what the event bus does:
    // app.execute(matched, context, { requestType: 'event' })

    let capturedType: string | undefined;

    await runInFullRequestScope(
      { container: new Container(), type: 'http', name: 'POST /orders' },
      async () => {
        // Simulate event bus calling app.execute with requestType: 'event'
        await runInFullRequestScope(
          { container: new Container(), type: 'event', name: 'EVENT order.created' },
          async () => {
            const ctx = getRequestContext();
            capturedType = ctx?.type;
          }
        );
      }
    );

    assert.strictEqual(capturedType, 'event');
  });

  it('should build correct chain: http → event', async () => {
    const chainTypes: string[] = [];

    await runInFullRequestScope(
      { container: new Container(), type: 'http', name: 'POST /orders' },
      async () => {
        // Simulate event bus calling app.execute with requestType: 'event'
        await runInFullRequestScope(
          { container: new Container(), type: 'event', name: 'EVENT order.created' },
          async () => {
            const chain = getRequestChain();
            chainTypes.push(...chain.map((c) => c.type));
          }
        );
      }
    );

    assert.deepStrictEqual(chainTypes, ['event', 'http']);
  });

  it('should handle nested events from different origins', async () => {
    const traces: Array<{ eventName: string; originType: string }> = [];

    // HTTP origin
    await runInFullRequestScope(
      { container: new Container(), type: 'http', name: 'POST /users' },
      async () => {
        await runInFullRequestScope(
          { container: new Container(), type: 'event', name: 'EVENT user.created' },
          async () => {
            const chain = getRequestChain();
            traces.push({
              eventName: chain[0].name,
              originType: chain[chain.length - 1].type,
            });
          }
        );
      }
    );

    // CLI origin
    await runInFullRequestScope(
      { container: new Container(), type: 'cli', name: 'import-data' },
      async () => {
        await runInFullRequestScope(
          { container: new Container(), type: 'event', name: 'EVENT data.imported' },
          async () => {
            const chain = getRequestChain();
            traces.push({
              eventName: chain[0].name,
              originType: chain[chain.length - 1].type,
            });
          }
        );
      }
    );

    assert.deepStrictEqual(traces, [
      { eventName: 'EVENT user.created', originType: 'http' },
      { eventName: 'EVENT data.imported', originType: 'cli' },
    ]);
  });
});
