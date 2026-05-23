/**
 * CLI Route Builder Tests
 *
 * Tests the CLI builder pattern using the new core builder infrastructure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { executeRoute } from '../../src/index.js';
import { Cli, createCliRouteBuilder, INPUT_SCHEMA } from '../../src/cli/builder/create-cli-builder.js';
import type { CliIO } from '../../src/cli/io.js';

// ============================================================================
// Test Helpers
// ============================================================================

/** Create a mock CliIO for testing */
function createMockIO(): CliIO<any> & {
  output: string[]
  errors: string[]
  results: unknown[]
} {
  const output: string[] = [];
  const errors: string[] = [];
  const results: unknown[] = [];

  return {
    output,
    errors,
    results,
    write: (text: string) => output.push(text),
    log: (message: string) => output.push(message),
    warn: (message: string) => output.push(`[WARN] ${message}`),
    error: (message: string) => errors.push(message),
    debug: (message: string) => output.push(`[DEBUG] ${message}`),
    result: (data: unknown) => results.push(data),
    prompt: async () => '',
    confirm: async () => false,
    select: async <T extends string>(q: string, choices: T[]) => choices[0],
    multiSelect: async <T extends string>(q: string, choices: T[]) => [],
    password: async () => '',
    progress: () => ({ update: () => {}, complete: () => {}, fail: () => {} }),
    spinner: () => ({ text: () => {}, success: () => {}, fail: () => {}, stop: () => {} }),
    table: () => {},
    hr: () => {},
    newline: () => {},
    isInteractive: false,
    isVerbose: false,
  };
}

// ============================================================================
// Builder Pattern Tests
// ============================================================================

describe('CLI Route Builder', () => {

  describe('Basic Builder Pattern', () => {

    it('should create a route with correct command name', () => {
      const route = Cli('build').handle(() => {});

      assert.strictEqual(route.path, 'build');
      assert.strictEqual(route.method, 'CLI');
    });

    it('should have empty steps array when no middleware/guards', () => {
      const route = Cli('test').handle(() => {});

      assert.ok(Array.isArray(route.steps));
      assert.strictEqual(route.steps.length, 0);
    });

    it('should support createCliRouteBuilder factory', () => {
      const route = createCliRouteBuilder('deploy').handle(() => {});

      assert.strictEqual(route.path, 'deploy');
      assert.strictEqual(route.method, 'CLI');
    });
  });

  describe('Input Schema', () => {

    it('should store input schema on route', () => {
      const schema = z.object({
        src: z.string(),
        verbose: z.boolean().default(false),
      });

      const route = Cli('build')
        .input(schema)
        .handle(() => {});

      assert.strictEqual(route.inputSchema, schema);
      // Also verify symbol-based access for backward compat
      assert.strictEqual((route as any)[INPUT_SCHEMA], schema);
    });

    it('should work without input schema', () => {
      const route = Cli('status').handle(() => {});

      assert.strictEqual(route.inputSchema, undefined);
    });
  });

  describe('Middleware (use)', () => {

    it('should add use step to route', () => {
      const route = Cli('build')
        .use(() => ({ timestamp: Date.now() }))
        .handle(() => {});

      assert.strictEqual(route.steps.length, 1);
      assert.strictEqual(route.steps[0].type, 'use');
    });

    it('should allow multiple use steps', () => {
      const route = Cli('build')
        .use(() => ({ step1: true }))
        .use(() => ({ step2: true }))
        .use(() => ({ step3: true }))
        .handle(() => {});

      assert.strictEqual(route.steps.length, 3);
      assert.ok(route.steps.every(s => s.type === 'use'));
    });
  });

  describe('Guards', () => {

    it('should add guard step to route', () => {
      const route = Cli('deploy')
        .guard(() => undefined)
        .handle(() => {});

      assert.strictEqual(route.steps.length, 1);
      assert.strictEqual(route.steps[0].type, 'guard');
    });

    it('should preserve order of use and guard steps', () => {
      const route = Cli('deploy')
        .use(() => ({ env: 'prod' }))
        .guard(() => undefined)
        .use(() => ({ ready: true }))
        .handle(() => {});

      assert.strictEqual(route.steps.length, 3);
      assert.strictEqual(route.steps[0].type, 'use');
      assert.strictEqual(route.steps[1].type, 'guard');
      assert.strictEqual(route.steps[2].type, 'use');
    });
  });

  describe('Returns (Response Schemas)', () => {

    it('should register response schema', () => {
      const SuccessSchema = z.object({ success: z.boolean() });

      const route = Cli('build')
        .returns(0, SuccessSchema)
        .handle(() => {});

      assert.ok(route.responseSchemas.has(0));
      assert.strictEqual(route.responseSchemas.get(0), SuccessSchema);
    });

    it('should support multiple response schemas', () => {
      const route = Cli('build')
        .returns(0, z.object({ success: z.boolean() }))
        .returns(1, z.object({ error: z.string() }))
        .handle(() => {});

      assert.ok(route.responseSchemas.has(0));
      assert.ok(route.responseSchemas.has(1));
    });
  });
});

// ============================================================================
// Execution Tests
// ============================================================================

describe('CLI Route Execution', () => {

  it('should execute route handler with context', async () => {
    let receivedContext: any = null;

    const route = Cli('test')
      .handle((ctx) => {
        receivedContext = ctx;
      });

    const io = createMockIO();
    const ctx = {
      args: { name: 'world' },
      io,
    };

    await executeRoute(route, ctx);

    assert.ok(receivedContext);
    assert.deepStrictEqual(receivedContext.args, { name: 'world' });
    assert.strictEqual(receivedContext.io, io);
  });

  it('should accumulate context from middleware', async () => {
    let finalContext: any = null;

    const route = Cli('build')
      .use(() => ({ step1: 'first' }))
      .use((ctx) => ({ step2: ctx.step1 + '-second' }))
      .handle((ctx) => {
        finalContext = ctx;
      });

    const io = createMockIO();
    await executeRoute(route, { args: {}, io });

    assert.strictEqual(finalContext.step1, 'first');
    assert.strictEqual(finalContext.step2, 'first-second');
  });

  it('should stop execution when guard returns stop()', async () => {
    let handlerCalled = false;
    const io = createMockIO();

    const route = Cli('deploy')
      .guard((ctx) => {
        ctx.io.error('Access denied');
        return ctx.stop();
      })
      .handle(() => {
        handlerCalled = true;
      });

    await executeRoute(route, { args: {}, io });

    assert.strictEqual(handlerCalled, false);
    assert.ok(io.errors.includes('Access denied'));
  });

  it('should continue execution when guard does not stop', async () => {
    let handlerCalled = false;
    const io = createMockIO();

    const route = Cli('deploy')
      .guard(() => {
        // Guard passes - no stop
        return undefined;
      })
      .handle(() => {
        handlerCalled = true;
      });

    await executeRoute(route, { args: {}, io });

    assert.strictEqual(handlerCalled, true);
  });

  it('should execute async middleware', async () => {
    let finalContext: any = null;
    const io = createMockIO();

    const route = Cli('fetch')
      .use(async () => {
        await new Promise(r => setTimeout(r, 10));
        return { data: 'fetched' };
      })
      .handle((ctx) => {
        finalContext = ctx;
      });

    await executeRoute(route, { args: {}, io });

    assert.strictEqual(finalContext.data, 'fetched');
  });

  it('should provide stop function to guards', async () => {
    let stopFnReceived = false;
    const io = createMockIO();

    const route = Cli('check')
      .guard((ctx) => {
        stopFnReceived = typeof ctx.stop === 'function';
        return undefined;
      })
      .handle(() => {});

    await executeRoute(route, { args: {}, io });

    assert.strictEqual(stopFnReceived, true);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('CLI Builder Integration', () => {

  it('should support complete build command flow', async () => {
    const io = createMockIO();
    let buildExecuted = false;
    let receivedSrc = '';

    const BuildArgs = z.object({
      src: z.string(),
      outDir: z.string().default('./dist'),
      verbose: z.boolean().default(false),
    });

    const route = Cli('build')
      .input(BuildArgs)
      .use((ctx) => ({
        resolvedSrc: `/absolute/${ctx.args.src}`
      }))
      .guard((ctx) => {
        if (ctx.args.src === 'forbidden') {
          ctx.io.error('Cannot build forbidden source');
          return ctx.stop();
        }
      })
      .handle((ctx) => {
        buildExecuted = true;
        receivedSrc = ctx.resolvedSrc;
        ctx.io.log(`Building ${ctx.resolvedSrc}`);
      });

    const ctx = {
      args: { src: 'myproject', outDir: './dist', verbose: false },
      io,
    };

    await executeRoute(route, ctx);

    assert.strictEqual(buildExecuted, true);
    assert.strictEqual(receivedSrc, '/absolute/myproject');
    assert.ok(io.output.includes('Building /absolute/myproject'));
  });

  it('should block forbidden source in guard', async () => {
    const io = createMockIO();
    let buildExecuted = false;

    const route = Cli('build')
      .input(z.object({ src: z.string() }))
      .guard((ctx) => {
        if (ctx.args.src === 'forbidden') {
          ctx.io.error('Cannot build forbidden source');
          return ctx.stop();
        }
      })
      .handle(() => {
        buildExecuted = true;
      });

    const ctx = {
      args: { src: 'forbidden' },
      io,
    };

    await executeRoute(route, ctx);

    assert.strictEqual(buildExecuted, false);
    assert.ok(io.errors.includes('Cannot build forbidden source'));
  });

  it('should support io.result() for structured output', async () => {
    const io = createMockIO();

    const StatusResult = z.object({
      branch: z.string(),
      clean: z.boolean(),
    });

    const route = Cli('status')
      .returns(0, StatusResult)
      .handle((ctx) => {
        ;(ctx.io as unknown as CliIO<{ branch: string; clean: boolean }>).result({ branch: 'main', clean: true });
      });

    await executeRoute(route, { args: {}, io });

    assert.strictEqual(io.results.length, 1);
    assert.deepStrictEqual(io.results[0], { branch: 'main', clean: true });
  });
});
