/**
 * Pino-backed Logger - the default observability backend.
 *
 * Emits structured NDJSON to stdout (Loki/Promtail/Alloy-ready) with zero
 * worker threads on the default path: pino writes through `sonic-boom`
 * in-process. Worker-thread transports (`pino-pretty`, `pino-loki`) are only
 * spun up when `pretty` / `loki` are explicitly configured, so tests and the
 * default app stay leak-free.
 *
 * Every log line is enriched at log time (not bind time, since a Logger
 * instance is long-lived per injection) with the active observability context
 * - `requestId`, route, and any trace ids an instrumentation merged in - and
 * still fires the `emitLog` instrumentation hook so OTel span-correlation
 * keeps working regardless of backend.
 */

import type pino from 'pino';
import { createRequire } from 'node:module';
import {
  Logger,
  LoggerFactory,
  type LogAttributes,
  type LogLevel,
  getContext,
  getMinLogLevel,
  setMinLogLevel,
  isLevelEnabled,
  emitLog,
  type ObservabilityContext,
} from './logger.js';

const require = createRequire(import.meta.url);

/** Direct-to-Loki push (pino-loki transport). Optional dependency. */
export interface LokiTransportConfig {
  /** Loki base URL, e.g. `http://localhost:3100` */
  host: string;
  /** Static labels attached to every stream (e.g. `{ app: 'api', env: 'prod' }`) */
  labels?: Record<string, string>;
  /** Basic auth, if your Loki is protected */
  basicAuth?: { username: string; password: string };
  /** Batch interval in seconds (pino-loki default applies when omitted) */
  interval?: number;
}

export interface PinoLoggerConfig {
  /** Minimum level. Defaults to the framework's current minimum (env-seeded). */
  level?: LogLevel;
  /**
   * `json` (default) writes NDJSON to stdout - what every Loki collector wants.
   * `pretty` uses the pino-pretty transport (worker thread) for local dev.
   */
  format?: 'json' | 'pretty';
  /** Paths to redact from every line, e.g. `['req.headers.authorization', '*.password']`. */
  redact?: string[];
  /** Static fields merged into every line (service, env, version, ...). */
  base?: Record<string, unknown>;
  /** Opt-in direct push to Loki, in addition to stdout JSON. */
  loki?: LokiTransportConfig;
  /**
   * Override the JSON destination (default: stdout / fd 1). Honoured only on
   * the plain-JSON path - ignored when `pretty` or `loki` transports are on.
   * Useful for redirecting to a file descriptor or capturing in tests.
   */
  destination?: pino.DestinationStream;
}

/** Build the shared pino base instance from config. */
function buildPino(config: PinoLoggerConfig): pino.Logger {
  // Lazy `require` so pino is only loaded when this backend is actually used.
  const pinoFactory = require('pino') as typeof pino;

  const options: pino.LoggerOptions = {
    // The framework's `isLevelEnabled` gate (driven by the global minimum,
    // runtime-settable via setMinLogLevel) is the single source of truth and
    // runs before pino is ever called. Pino's own gate is therefore opened
    // fully so the two can never disagree - and no per-factory level listener
    // is needed (which would leak on the module-level subscription set).
    level: 'trace',
    // Emit the level as its string label ("info") rather than pino's numeric
    // code - far friendlier for Loki/Grafana queries.
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pinoFactory.stdTimeFunctions.isoTime,
    ...(config.redact ? { redact: config.redact } : {}),
    ...(config.base ? { base: config.base } : {}),
  };

  const wantsPretty = config.format === 'pretty';

  // No transport => pino writes JSON to stdout via in-process sonic-boom.
  // No worker thread, no teardown leak. This is the default + test path.
  if (!wantsPretty && !config.loki) {
    return config.destination
      ? pinoFactory(options, config.destination)
      : pinoFactory(options);
  }

  // Transport path: each target runs in a worker thread. Opt-in only.
  const targets: pino.TransportTargetOptions[] = [];

  if (wantsPretty) {
    targets.push({
      target: 'pino-pretty',
      level: options.level as string,
      options: { colorize: true, translateTime: 'SYS:standard' },
    });
  } else {
    // Always keep structured stdout, even when also pushing to Loki.
    targets.push({
      target: 'pino/file',
      level: options.level as string,
      options: { destination: 1 },
    });
  }

  if (config.loki) {
    targets.push({
      target: 'pino-loki',
      level: options.level as string,
      options: {
        host: config.loki.host,
        labels: config.loki.labels,
        basicAuth: config.loki.basicAuth,
        ...(config.loki.interval !== undefined ? { interval: config.loki.interval } : {}),
        // Surface transport failures instead of swallowing them silently.
        silenceErrors: false,
      },
    });
  }

  return pinoFactory({ ...options, transport: { targets } });
}

/** Strip framework-internal (`_`-prefixed) keys; copy string-keyed context. */
function contextBindings(ctx: ObservabilityContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ctx)) {
    if (key.startsWith('_')) continue;
    out[key] = ctx[key];
  }
  return out;
}

class PinoLogger extends Logger {
  constructor(
    private readonly pinoBase: pino.Logger,
    private readonly name: string
  ) {
    super();
  }

  private log(level: LogLevel, message: string, attributes?: LogAttributes): void {
    // Authoritative gate - matches ConsoleLogger and governs emitLog too, so
    // runtime setMinLogLevel() takes effect immediately for every backend.
    if (!isLevelEnabled(level)) return;

    const ctx = getContext();
    const bindings = contextBindings(ctx);
    bindings.name = this.name;
    if (attributes) Object.assign(bindings, attributes);

    this.pinoBase[level](bindings, message);
    emitLog(level, message, attributes ?? {}, ctx);
  }

  trace(message: string, attributes?: LogAttributes): void {
    this.log('trace', message, attributes);
  }
  debug(message: string, attributes?: LogAttributes): void {
    this.log('debug', message, attributes);
  }
  info(message: string, attributes?: LogAttributes): void {
    this.log('info', message, attributes);
  }
  warn(message: string, attributes?: LogAttributes): void {
    this.log('warn', message, attributes);
  }
  error(message: string, attributes?: LogAttributes): void {
    this.log('error', message, attributes);
  }

  child(childName: string): Logger {
    return new PinoLogger(this.pinoBase, `${this.name}:${childName}`);
  }
}

/**
 * The default LoggerFactory. One shared pino instance, one PinoLogger per
 * injection (named by its resolution context). Keeps its level in sync with
 * the framework's `setMinLogLevel`.
 */
export class PinoLoggerFactory extends LoggerFactory {
  private readonly pinoBase: pino.Logger;

  constructor(config: PinoLoggerConfig = {}) {
    super();
    // A configured level sets the framework-wide minimum (the gate every
    // backend shares), rather than a private per-factory threshold.
    if (config.level) setMinLogLevel(config.level);
    this.pinoBase = buildPino(config);
  }

  create(name: string): Logger {
    return new PinoLogger(this.pinoBase, name);
  }

  /** Flush buffered logs (relevant for the loki/pretty transport paths). */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.pinoBase.flush(() => resolve()));
  }
}

/** Read the default logger config from environment variables. */
export function loggerConfigFromEnv(): PinoLoggerConfig {
  const format = process.env.JUSTSCALE_LOG_FORMAT?.toLowerCase();
  return {
    level: getMinLogLevel(),
    format: format === 'pretty' ? 'pretty' : 'json',
    ...(process.env.JUSTSCALE_LOG_LOKI_URL
      ? { loki: { host: process.env.JUSTSCALE_LOG_LOKI_URL } }
      : {}),
  };
}
