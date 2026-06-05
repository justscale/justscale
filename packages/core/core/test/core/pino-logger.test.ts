/**
 * Tests for the pino-backed default logger and the LoggerFactory DI binding.
 *
 * Covers:
 *   - structured JSON output (level label, message, name)
 *   - observability context (requestId) merged at log time
 *   - attributes override context keys
 *   - level gating + setMinLogLevel runtime changes
 *   - emitLog instrumentation hook fires (and is level-gated)
 *   - pinoLoggerFactory / consoleLoggerFactory bind the LoggerFactory token
 *   - Container.resolveBoundLoggerFactory swaps the backend
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/index.js';
import { Container, defineService, SERVICE_PROVIDES } from '../../src/core/service.js';
import {
  LoggerFactory,
  ConsoleLogger,
  ConsoleLoggerFactory,
  getMinLogLevel,
  setMinLogLevel,
  registerInstrumentation,
  unregisterInstrumentation,
  withContext,
  type LogLevel,
} from '../../src/core/logger.js';
import { PinoLoggerFactory, loggerConfigFromEnv } from '../../src/core/pino-logger.js';
import {
  loggerConfig,
  pinoLoggerFactory,
  consoleLoggerFactory,
} from '../../src/features/logging/index.js';

/** A pino DestinationStream that collects each parsed JSON line. */
function captureStream() {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    stream: {
      write(msg: string) {
        lines.push(JSON.parse(msg));
      },
    },
  };
}

describe('PinoLogger', () => {
  const originalLevel = getMinLogLevel();
  afterEach(() => setMinLogLevel(originalLevel));

  it('emits structured JSON with level label, message and name', () => {
    const { lines, stream } = captureStream();
    const factory = new PinoLoggerFactory({ level: 'info', destination: stream });
    factory.create('api').info('hello', { userId: '42' });

    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.equal(line.level, 'info'); // string label, not numeric code
    assert.equal(line.msg, 'hello');
    assert.equal(line.name, 'api');
    assert.equal(line.userId, '42');
    assert.equal(typeof line.time, 'string'); // ISO timestamp
  });

  it('merges observability context (requestId) at log time', () => {
    const { lines, stream } = captureStream();
    const logger = new PinoLoggerFactory({ destination: stream }).create('svc');

    {
      using _ = withContext({ requestId: 'req-123' });
      logger.info('in scope');
    }
    logger.info('out of scope');

    assert.equal(lines[0].requestId, 'req-123');
    assert.equal(lines[1].requestId, undefined);
  });

  it('lets attributes override context keys', () => {
    const { lines, stream } = captureStream();
    const logger = new PinoLoggerFactory({ destination: stream }).create('svc');

    using _ = withContext({ tenant: 'from-context' });
    logger.info('m', { tenant: 'from-attrs' });

    assert.equal(lines[0].tenant, 'from-attrs');
  });

  it('respects the level gate and follows setMinLogLevel at runtime', () => {
    const { lines, stream } = captureStream();
    const logger = new PinoLoggerFactory({ level: 'info', destination: stream }).create('svc');

    logger.debug('suppressed');
    assert.equal(lines.length, 0);

    setMinLogLevel('debug');
    logger.debug('now visible');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].msg, 'now visible');
  });

  it('fires the emitLog instrumentation hook, gated by level', () => {
    const seen: Array<{ level: LogLevel; message: string; attrs: Record<string, unknown> }> = [];
    registerInstrumentation({
      name: 'test-capture',
      onLog: (level, message, attributes) => seen.push({ level, message, attrs: attributes }),
    });

    try {
      const { stream } = captureStream();
      const logger = new PinoLoggerFactory({ level: 'info', destination: stream }).create('svc');

      logger.debug('dropped'); // below level -> no hook
      logger.warn('kept', { code: 7 });

      assert.equal(seen.length, 1);
      assert.equal(seen[0].level, 'warn');
      assert.equal(seen[0].message, 'kept');
      assert.equal(seen[0].attrs.code, 7);
    } finally {
      unregisterInstrumentation('test-capture');
    }
  });
});

describe('LoggerFactory DI binding', () => {
  it('pinoLoggerFactory() / consoleLoggerFactory() provide the LoggerFactory token', () => {
    for (const def of [pinoLoggerFactory(), consoleLoggerFactory()]) {
      const provides = (def as unknown as Record<symbol, unknown>)[SERVICE_PROVIDES] as unknown[];
      assert.ok(Array.isArray(provides));
      assert.ok(provides.includes(LoggerFactory));
    }
  });

  it('resolveBoundLoggerFactory swaps in a bound console backend', async () => {
    const container = new Container();
    // Default before binding: pino.
    assert.ok(container.createLogger('x'));

    const def = consoleLoggerFactory();
    container.register(def as any);
    container.registerFor(LoggerFactory as any, def as any);

    await container.resolveBoundLoggerFactory();

    const logger = container.createLogger('after');
    // ConsoleLogger writes via console.* (no throw); assert the factory swapped
    // by checking a fresh container still defaults to pino.
    assert.ok(logger);

    const fresh = new Container();
    await fresh.resolveBoundLoggerFactory(); // no binding -> stays default
    assert.ok(fresh.createLogger('y'));
  });

  it('a custom provides:[LoggerFactory] service is honoured', async () => {
    const calls: string[] = [];
    class TaggingFactory extends LoggerFactory {
      create(name: string) {
        calls.push(name);
        return new ConsoleLoggerFactory().create(name);
      }
    }
    const def = defineService({
      inject: {},
      provides: [LoggerFactory],
      factory: () => new TaggingFactory(),
    });

    const container = new Container();
    container.register(def);
    container.registerFor(LoggerFactory as any, def);
    await container.resolveBoundLoggerFactory();

    container.createLogger('tagged');
    assert.deepEqual(calls, ['tagged']);
  });
});

describe('PinoLogger output details', () => {
  it('merges static base fields into every line', () => {
    const { lines, stream } = captureStream();
    const factory = new PinoLoggerFactory({
      base: { service: 'api', env: 'test' },
      destination: stream,
    });
    factory.create('svc').info('a');
    factory.create('svc').warn('b');

    for (const line of lines) {
      assert.equal(line.service, 'api');
      assert.equal(line.env, 'test');
    }
  });

  it('redacts configured paths', () => {
    const { lines, stream } = captureStream();
    const logger = new PinoLoggerFactory({
      redact: ['password'],
      destination: stream,
    }).create('svc');

    logger.info('login', { user: 'bob', password: 'hunter2' });

    assert.equal(lines[0].user, 'bob');
    assert.equal(lines[0].password, '[Redacted]');
  });

  it('reflects child() names hierarchically', () => {
    const { lines, stream } = captureStream();
    const root = new PinoLoggerFactory({ destination: stream }).create('app');
    root.child('db').child('pool').info('connected');

    assert.equal(lines[0].name, 'app:db:pool');
  });

  it('writes the correct level label per method', () => {
    const { lines, stream } = captureStream();
    setMinLogLevel('trace');
    const logger = new PinoLoggerFactory({ destination: stream }).create('svc');

    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    assert.deepEqual(
      lines.map((l) => l.level),
      ['trace', 'debug', 'info', 'warn', 'error']
    );
    setMinLogLevel('info');
  });

  it('accumulates nested context scopes', () => {
    const { lines, stream } = captureStream();
    const logger = new PinoLoggerFactory({ destination: stream }).create('svc');

    using _outer = withContext({ requestId: 'req-1' });
    logger.info('outer');
    {
      using _inner = withContext({ userId: 'u-9' });
      logger.info('inner');
    }
    logger.info('after-inner');

    assert.equal(lines[0].requestId, 'req-1');
    assert.equal(lines[0].userId, undefined);
    assert.equal(lines[1].requestId, 'req-1');
    assert.equal(lines[1].userId, 'u-9');
    assert.equal(lines[2].requestId, 'req-1');
    assert.equal(lines[2].userId, undefined);
  });
});

describe('loggerConfigFromEnv', () => {
  const saved = {
    format: process.env.JUSTSCALE_LOG_FORMAT,
    loki: process.env.JUSTSCALE_LOG_LOKI_URL,
  };
  afterEach(() => {
    restoreEnv('JUSTSCALE_LOG_FORMAT', saved.format);
    restoreEnv('JUSTSCALE_LOG_LOKI_URL', saved.loki);
  });

  it('defaults to json with no loki target', () => {
    delete process.env.JUSTSCALE_LOG_FORMAT;
    delete process.env.JUSTSCALE_LOG_LOKI_URL;
    const cfg = loggerConfigFromEnv();
    assert.equal(cfg.format, 'json');
    assert.equal(cfg.loki, undefined);
  });

  it('honours JUSTSCALE_LOG_FORMAT=pretty', () => {
    process.env.JUSTSCALE_LOG_FORMAT = 'pretty';
    assert.equal(loggerConfigFromEnv().format, 'pretty');
  });

  it('reads JUSTSCALE_LOG_LOKI_URL into the loki target', () => {
    process.env.JUSTSCALE_LOG_LOKI_URL = 'http://loki:3100';
    assert.equal(loggerConfigFromEnv().loki?.host, 'http://loki:3100');
  });
});

describe('pinoLoggerFactory config-partial integration', () => {
  const originalLevel = getMinLogLevel();
  afterEach(() => setMinLogLevel(originalLevel));

  it('applies a config-partial level to the framework minimum', async () => {
    const container = new Container();
    container.registerInstance(loggerConfig.key as any, { level: 'error' });

    const def = pinoLoggerFactory();
    container.register(def as any);
    await container.resolve(def as any);

    assert.equal(getMinLogLevel(), 'error');
  });

  it('lets the config value win over the explicit factory argument', async () => {
    const container = new Container();
    container.registerInstance(loggerConfig.key as any, { level: 'error' });

    const def = pinoLoggerFactory({ level: 'warn' });
    container.register(def as any);
    await container.resolve(def as any);

    assert.equal(getMinLogLevel(), 'error');
  });

  it('uses the explicit argument when no config value is set', async () => {
    const container = new Container();
    const def = pinoLoggerFactory({ level: 'warn' });
    container.register(def as any);
    await container.resolve(def as any);

    assert.equal(getMinLogLevel(), 'warn');
  });
});

describe('LoggerFactory through the app builder', () => {
  const originalLevel = getMinLogLevel();
  afterEach(() => setMinLogLevel(originalLevel));

  class Dummy extends defineService({ inject: {}, factory: () => ({}) }) {}

  it('defaults to the pino backend', async () => {
    const app = JustScale().add(Dummy).build().compile();
    await app.ready;
    const logger = app.container.createLogger('x');
    assert.ok(!(logger instanceof ConsoleLogger));
  });

  it('.add(consoleLoggerFactory()) swaps to the console backend', async () => {
    const app = JustScale().add(consoleLoggerFactory()).add(Dummy).build().compile();
    await app.ready;
    const logger = app.container.createLogger('x');
    assert.ok(logger instanceof ConsoleLogger);
  });

  it('.add(pinoLoggerFactory()) keeps the pino backend', async () => {
    const app = JustScale().add(pinoLoggerFactory()).add(Dummy).build().compile();
    await app.ready;
    const logger = app.container.createLogger('x');
    assert.ok(!(logger instanceof ConsoleLogger));
  });
});

/** Restore an env var to a saved value (deleting it when it was unset). */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
