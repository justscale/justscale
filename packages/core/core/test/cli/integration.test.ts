/**
 * End-to-End Integration Tests for CLI Runner
 *
 * Tests the complete flow from CLI route definition to execution through the runner,
 * validating that all middleware, guards, input validation, and programmatic invocation work correctly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { Cli } from '../../src/cli/builder/create-cli-builder.js';
import { invoke, run } from '../../src/cli/runner.js';
import { createMockIO } from '../../src/cli/io.js';
import type { CliIO } from '../../src/cli/io.js';
import type { App } from '../../src/index.js';

/**
 * Create a minimal app for testing without full builder.
 * This is a lightweight test helper that bypasses the full app creation.
 */
function createTestApp(controllers: any[]): App {
  return {
    controllers: controllers.map(ctrl => ({
      ...ctrl,
      deps: {},
      routes: ctrl.routes,
    })),
    container: null as any,
    adapters: [],
    subApps: [],
    ready: Promise.resolve(),
    match: () => null,
    execute: async () => {},
  };
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a simple controller with CLI routes.
 * Mimics the structure of a real controller but simplified for testing.
 */
function createTestController(routes: any[], command?: string) {
  return {
    settings: command ? { command } : {},
    routes: routes,
  };
}

/**
 * Create mock IO with enhanced capabilities for testing
 */
function createTestIO(): CliIO<any> & {
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
// Integration Tests: Complete CLI Flow
// ============================================================================

describe('CLI Runner Integration - Complete Flow', () => {

  it('should execute simple command with no args', async () => {
    let handlerCalled = false;

    const route = Cli('hello')
      .handle((ctx) => {
        handlerCalled = true;
        ctx.io.log('Hello, world!');
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['hello'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(handlerCalled, true);
    assert.ok(io.output.includes('Hello, world!'));
  });

  it('should validate input schema and parse arguments', async () => {
    let receivedArgs: any = null;

    const BuildArgs = z.object({
      src: z.string(),
      outDir: z.string().default('./dist'),
      verbose: z.boolean().default(false),
    });

    const route = Cli('build')
      .input(BuildArgs)
      .handle((ctx) => {
        receivedArgs = ctx.args;
        ctx.io.log(`Building ${ctx.args.src}`);
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    // Note: src is required without default, so it's a positional arg (not --src flag)
    const result = await run(app, {
      argv: ['build', './my-project', '--verbose'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
    assert.ok(receivedArgs);
    assert.strictEqual(receivedArgs.src, './my-project');
    assert.strictEqual(receivedArgs.outDir, './dist'); // default value
    assert.strictEqual(receivedArgs.verbose, true);
    assert.ok(io.output.includes('Building ./my-project'));
  });

  it('should accumulate context through middleware', async () => {
    let finalContext: any = null;

    const route = Cli('deploy')
      .use(() => ({ env: 'production' }))
      .use((ctx) => ({ region: `${ctx.env}-us-west` }))
      .use((ctx) => ({ timestamp: Date.now(), envRegion: ctx.region }))
      .handle((ctx) => {
        finalContext = ctx;
        ctx.io.log(`Deploying to ${ctx.envRegion}`);
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['deploy'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
    assert.ok(finalContext);
    assert.strictEqual(finalContext.env, 'production');
    assert.strictEqual(finalContext.region, 'production-us-west');
    assert.ok(typeof finalContext.timestamp === 'number');
    assert.strictEqual(finalContext.envRegion, 'production-us-west');
    assert.ok(io.output.some(msg => msg.includes('Deploying to production-us-west')));
  });

  it('should stop execution when guard returns stop()', async () => {
    let handlerCalled = false;

    const route = Cli('admin')
      .use(() => ({ authenticated: false }))
      .guard((ctx) => {
        if (!ctx.authenticated) {
          ctx.io.error('Authentication required');
          return ctx.stop();
        }
      })
      .handle(() => {
        handlerCalled = true;
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['admin'],
      io,
      exitOnError: false,
    });

    // Execution completed but handler was not called
    assert.strictEqual(result.success, true);
    assert.strictEqual(handlerCalled, false);
    assert.ok(io.errors.includes('Authentication required'));
  });

  it('should allow execution when guard does not stop', async () => {
    let handlerCalled = false;

    const route = Cli('admin')
      .use(() => ({ authenticated: true }))
      .guard((ctx) => {
        if (!ctx.authenticated) {
          ctx.io.error('Authentication required');
          return ctx.stop();
        }
      })
      .handle(() => {
        handlerCalled = true;
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['admin'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(handlerCalled, true);
    assert.strictEqual(io.errors.length, 0);
  });

  it('should handle validation errors gracefully', async () => {
    let handlerCalled = false;

    const StrictArgs = z.object({
      count: z.number().min(1).max(100),
      name: z.string().min(3),
    });

    const route = Cli('process')
      .input(StrictArgs)
      .handle(() => {
        handlerCalled = true;
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    // count and name are required without defaults, so they're positional args
    const result = await run(app, {
      argv: ['process', '0', 'ab'], // Invalid: count < 1, name too short (positional args)
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(handlerCalled, false);
    assert.ok(io.errors.length > 0);
    assert.ok(io.errors.some(e => e.startsWith('error:')));
    assert.ok(io.errors.some(e => e.includes('Usage:')));
  });

  it('top-level --help groups by prefix and shows descriptions', async () => {
    const addUser = Cli('user add')
      .describe('Create a new user account')
      .input(z.object({ email: z.string() }))
      .handle(() => {});
    const listUsers = Cli('user list')
      .describe('List all registered users')
      .handle(() => {});
    const revokeSession = Cli('session revoke')
      .describe('Revoke all sessions for a user')
      .handle(() => {});
    const status = Cli('status')
      .describe('Show runtime status')
      .handle(() => {});

    const app = createTestApp([
      createTestController([addUser, listUsers, revokeSession, status]),
    ]);

    const io = createTestIO();
    const result = await run(app, { argv: ['--help'], io, exitOnError: false });

    assert.strictEqual(result.success, true);
    const out = io.output.join('\n');

    // Top-level commands appear under "Commands:"
    assert.match(out, /^Commands:/m, 'missing top-level "Commands:" header');
    assert.match(out, /status\s+Show runtime status/);

    // Namespaced commands appear under their group header; within a
    // group the shared prefix is stripped so rows show just the
    // sub-command ("add", "list", "revoke") aligned with descriptions.
    assert.match(out, /^user:/m, 'missing "user:" group header');
    assert.match(out, /^\s+add\s+Create a new user account/m);
    assert.match(out, /^\s+list\s+List all registered users/m);
    assert.match(out, /^session:/m, 'missing "session:" group header');
    assert.match(out, /^\s+revoke\s+Revoke all sessions for a user/m);
  });

  it('per-command --help includes description and usage line', async () => {
    const route = Cli('user add')
      .describe('Create a new user account')
      .input(z.object({ email: z.string() }))
      .handle(() => {});
    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['user', 'add', '--help'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
    const out = io.output.join('\n');
    assert.match(out, /Create a new user account/);
    assert.match(out, /Usage: user add <email>/);
  });

  it('should use io.result() for structured output', async () => {
    const StatusResult = z.object({
      status: z.string(),
      uptime: z.number(),
      services: z.array(z.string()),
    });

    const route = Cli('status')
      .returns(0, StatusResult)
      .handle((ctx) => {
        ;(ctx.io as any).result({
          status: 'healthy',
          uptime: 12345,
          services: ['api', 'database', 'cache'],
        });
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['status'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(io.results.length, 1);
    const output = io.results[0] as any;
    assert.strictEqual(output.status, 'healthy');
    assert.strictEqual(output.uptime, 12345);
    assert.deepStrictEqual(output.services, ['api', 'database', 'cache']);
  });
});

// ============================================================================
// Integration Tests: Programmatic Invocation
// ============================================================================

describe('CLI Runner Integration - Programmatic Invocation', () => {

  it('should invoke command programmatically with invoke()', async () => {
    const BuildResult = z.object({
      success: z.boolean(),
      outputPath: z.string(),
    });

    const BuildArgs = z.object({
      src: z.string(),
      outDir: z.string().default('./dist'),
    });

    const route = Cli('build')
      .input(BuildArgs)
      .returns(0, BuildResult)
      .handle((ctx) => {
        ;(ctx.io as any).result({
          success: true,
          outputPath: `${ctx.args.outDir}/bundle.js`,
        });
      });

    const app = createTestApp([createTestController([route])]);

    const result = await invoke<{ success: boolean; outputPath: string }>(
      app,
      'build',
      { src: './src' }
    );

    assert.ok(result);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.outputPath, './dist/bundle.js');
  });

  it('should validate args when invoking programmatically', async () => {
    const StrictArgs = z.object({
      port: z.number().min(1024).max(65535),
    });

    const route = Cli('serve')
      .input(StrictArgs)
      .handle(() => {});

    const app = createTestApp([createTestController([route])]);

    // Should throw on invalid args
    await assert.rejects(
      async () => {
        await invoke(app, 'serve', { port: 80 }); // Invalid: port < 1024
      },
      (err: any) => {
        assert.ok(err.message.includes('port'));
        return true;
      }
    );
  });

  it('should throw on unknown command', async () => {
    const app = createTestApp([createTestController([])]);

    await assert.rejects(
      async () => {
        await invoke(app, 'nonexistent', {});
      },
      (err: any) => {
        assert.ok(err.message.includes('Unknown command'));
        return true;
      }
    );
  });

  it('should work with middleware context in invoke()', async () => {
    const route = Cli('test')
      .use(() => ({ value: 42 }))
      .use((ctx) => ({ doubled: ctx.value * 2 }))
      .returns(0, z.object({ result: z.number() }))
      .handle((ctx) => {
        ;(ctx.io as any).result({ result: ctx.doubled });
      });

    const app = createTestApp([createTestController([route])]);

    const result = await invoke<{ result: number }>(app, 'test', {});

    assert.strictEqual(result.result, 84);
  });
});

// ============================================================================
// Integration Tests: Subcommands
// ============================================================================

describe('CLI Runner Integration - Subcommands', () => {

  it('should handle subcommands with prefix', async () => {
    let handlerCalled = false;

    const migrateRoute = Cli('migrate')
      .handle((ctx) => {
        handlerCalled = true;
        ctx.io.log('Running migrations');
      });

    const app = createTestApp([createTestController([migrateRoute], 'db')]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['db', 'migrate'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(handlerCalled, true);
    assert.ok(io.output.includes('Running migrations'));
  });

  it('should invoke subcommand programmatically', async () => {
    const route = Cli('status')
      .returns(0, z.object({ connected: z.boolean() }))
      .handle((ctx) => {
        ;(ctx.io as any).result({ connected: true });
      });

    const app = createTestApp([createTestController([route], 'db')]);

    const result = await invoke<{ connected: boolean }>(app, 'db status', {});

    assert.strictEqual(result.connected, true);
  });

  it('should handle multiple subcommand namespaces', async () => {
    const dbMigrate = Cli('migrate')
      .handle((ctx) => {
        ctx.io.log('DB: Running migrations');
      });

    const cacheClear = Cli('clear')
      .handle((ctx) => {
        ctx.io.log('Cache: Clearing cache');
      });

    const app = createTestApp([
      createTestController([dbMigrate], 'db'),
      createTestController([cacheClear], 'cache'),
    ]);

    // Test db migrate
    const io1 = createTestIO();
    await run(app, {
      argv: ['db', 'migrate'],
      io: io1,
      exitOnError: false,
    });
    assert.ok(io1.output.includes('DB: Running migrations'));

    // Test cache clear
    const io2 = createTestIO();
    await run(app, {
      argv: ['cache', 'clear'],
      io: io2,
      exitOnError: false,
    });
    assert.ok(io2.output.includes('Cache: Clearing cache'));
  });
});

// ============================================================================
// Integration Tests: Complex Scenarios
// ============================================================================

describe('CLI Runner Integration - Complex Scenarios', () => {

  it('should handle complete build pipeline with guards and middleware', async () => {
    const executionLog: string[] = [];
    let buildSuccess = false;

    const BuildArgs = z.object({
      src: z.string(),
      target: z.enum(['development', 'production']),
      minify: z.boolean().default(false),
    });

    const BuildResult = z.object({
      success: z.boolean(),
      outputPath: z.string(),
      size: z.number(),
    });

    const route = Cli('build')
      .input(BuildArgs)
      .use((ctx) => {
        executionLog.push('validate-source');
        return { srcExists: true }; // Simulated check
      })
      .guard((ctx) => {
        executionLog.push('check-source-exists');
        if (!ctx.srcExists) {
          ctx.io.error('Source directory not found');
          return ctx.stop();
        }
      })
      .use((ctx) => {
        executionLog.push('prepare-build');
        return {
          buildConfig: {
            minify: ctx.args.minify || ctx.args.target === 'production',
            sourcemap: ctx.args.target === 'development'
          }
        };
      })
      .guard((ctx) => {
        executionLog.push('check-dependencies');
        // Simulated dependency check - always pass
        return undefined;
      })
      .use((ctx) => {
        executionLog.push('execute-build');
        return { outputSize: 12345 };
      })
      .returns(0, BuildResult)
      .handle((ctx) => {
        executionLog.push('handler');
        buildSuccess = true;
        ctx.io.log(`Build complete: ${ctx.args.target}`)
        ;(ctx.io as any).result({
          success: true,
          outputPath: './dist/bundle.js',
          size: ctx.outputSize,
        });
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    // src and target are required without defaults, so they're positional args
    const result = await run(app, {
      argv: ['build', './src', 'production', '--minify'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(buildSuccess, true);

    // Verify execution order
    assert.deepStrictEqual(executionLog, [
      'validate-source',
      'check-source-exists',
      'prepare-build',
      'check-dependencies',
      'execute-build',
      'handler',
    ]);

    assert.ok(io.output.includes('Build complete: production'));
    assert.strictEqual(io.results.length, 1);
    const output = io.results[0] as any;
    assert.strictEqual(output.success, true);
    assert.strictEqual(output.size, 12345);
  });

  it('should handle async middleware and guards', async () => {
    let finalValue: any = null;

    const route = Cli('async-test')
      .use(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { step1: 'async-data' };
      })
      .guard(async (ctx) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (ctx.step1 !== 'async-data') {
          ctx.io.error('Async guard failed');
          return ctx.stop();
        }
      })
      .use(async (ctx) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { final: `${ctx.step1}-processed` };
      })
      .handle((ctx) => {
        finalValue = ctx.final;
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['async-test'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(finalValue, 'async-data-processed');
  });

  it('should provide io interface to all middleware and guards', async () => {
    const logs: string[] = [];

    const route = Cli('logging-test')
      .use((ctx) => {
        ctx.io.log('Middleware 1');
        logs.push('middleware-1');
        return {};
      })
      .guard((ctx) => {
        ctx.io.log('Guard 1');
        logs.push('guard-1');
        return undefined;
      })
      .use((ctx) => {
        ctx.io.log('Middleware 2');
        logs.push('middleware-2');
        return {};
      })
      .handle((ctx) => {
        ctx.io.log('Handler');
        logs.push('handler');
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    await run(app, {
      argv: ['logging-test'],
      io,
      exitOnError: false,
    });

    // Verify all steps logged
    assert.deepStrictEqual(logs, ['middleware-1', 'guard-1', 'middleware-2', 'handler']);
    assert.ok(io.output.includes('Middleware 1'));
    assert.ok(io.output.includes('Guard 1'));
    assert.ok(io.output.includes('Middleware 2'));
    assert.ok(io.output.includes('Handler'));
  });

  it('should support guards that use context from middleware', async () => {
    let handlerCalled = false;

    const route = Cli('permission-test')
      .input(z.object({ userId: z.string() }))
      .use(async (ctx) => {
        // Simulate user lookup
        const isAdmin = ctx.args.userId === 'admin';
        return { isAdmin, role: isAdmin ? 'admin' : 'user' };
      })
      .guard((ctx) => {
        if (!ctx.isAdmin) {
          ctx.io.error(`Access denied for role: ${ctx.role}`);
          return ctx.stop();
        }
        ctx.io.log('Admin access granted');
      })
      .handle(() => {
        handlerCalled = true;
      });

    const app = createTestApp([createTestController([route])]);

    // Test with admin user (userId is positional - required without default)
    const io1 = createTestIO();
    await run(app, {
      argv: ['permission-test', 'admin'],
      io: io1,
      exitOnError: false,
    });
    assert.strictEqual(handlerCalled, true);
    assert.ok(io1.output.includes('Admin access granted'));

    // Test with regular user (userId is positional)
    handlerCalled = false;
    const io2 = createTestIO();
    await run(app, {
      argv: ['permission-test', 'user123'],
      io: io2,
      exitOnError: false,
    });
    assert.strictEqual(handlerCalled, false);
    assert.ok(io2.errors.some(e => e.includes('Access denied')));
  });
});

// ============================================================================
// Integration Tests: Error Handling
// ============================================================================

describe('CLI Runner Integration - Error Handling', () => {

  it('should handle errors thrown in handler', async () => {
    const route = Cli('failing-command')
      .handle(() => {
        throw new Error('Something went wrong!');
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['failing-command'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.strictEqual(result.error.message, 'Something went wrong!');
    assert.ok(io.errors.some(e => e.includes('Something went wrong!')));
  });

  it('should handle errors in middleware', async () => {
    const route = Cli('test')
      .use(() => {
        throw new Error('Middleware error');
      })
      .handle(() => {
        // Should not reach here
      });

    const app = createTestApp([createTestController([route])]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['test'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.ok(result.error.message.includes('Middleware error'));
  });

  it('should handle unknown command gracefully', async () => {
    const app = createTestApp([createTestController([])]);

    const io = createTestIO();
    const result = await run(app, {
      argv: ['unknown-command'],
      io,
      exitOnError: false,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.ok(result.error.message.includes('Unknown command'));
  });
});
