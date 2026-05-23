/**
 * Logger for JustScale TypeScript
 *
 * Provides structured logging with timestamps for debugging
 * TypeScript/proto integration issues.
 *
 * Integrates with TypeScript's TSS_LOG environment variable:
 *   TSS_LOG="-logToFile true -file /path/to/log.txt -level verbose"
 *
 * Or use our own:
 *   JUSTSCALE_LOG=1 JUSTSCALE_LOG_LEVEL=debug
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Parse TSS_LOG environment variable (TypeScript's native logging)
function parseTssLog(): { file?: string; level: LogLevel } {
  const tssLog = process.env.TSS_LOG || '';
  let file: string | undefined;
  let level: LogLevel = 'info';

  // Parse -file flag
  const fileMatch = tssLog.match(/-file\s+(\S+)/);
  if (fileMatch) {
    file = fileMatch[1];
  }

  // Parse -level flag (verbose = debug, normal = info)
  if (tssLog.includes('-level verbose')) {
    level = 'debug';
  }

  return { file, level };
}

const tssConfig = parseTssLog();

// Log file location - prefer TSS_LOG, fallback to our default
const LOG_DIR = join(homedir(), '.justscale', 'logs');
const LOG_FILE = tssConfig.file || join(LOG_DIR, 'typescript.log');

// Minimum log level from environment (our var takes precedence)
const MIN_LEVEL: LogLevel = (process.env.JUSTSCALE_LOG_LEVEL as LogLevel) || tssConfig.level;

// Off by default — opt in with JUSTSCALE_LOG=1 or any TSS_LOG flag.
// Header docstring describes the env-var contract; this gate enforces it.
// Without this, every TS compile in any user's IDE writes to ~/.justscale/logs.
const LOGGING_ENABLED =
  process.env.JUSTSCALE_LOG === '1' || Boolean(process.env.TSS_LOG);

let initialized = false;

function ensureLogDir(): void {
  if (initialized) return;
  // Only create dir if using our default location (not TSS_LOG file)
  if (!tssConfig.file) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
    } catch {
      // Ignore - logging is best-effort
    }
  }
  initialized = true;
}

function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString();
}

function formatData(data: unknown): string {
  if (data === undefined) return '';

  // Handle objects with stack traces specially
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    const parts: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      if (key === 'stack' && typeof value === 'string') {
        // Format stack traces with actual newlines and indentation
        parts.push(`${key}:\n\t${value}`);
      } else if (typeof value === 'string') {
        parts.push(`${key}=${value}`);
      } else {
        parts.push(`${key}=${JSON.stringify(value)}`);
      }
    }

    return ' ' + parts.join(' ');
  }

  return ` ${JSON.stringify(data)}`;
}

function formatMessage(level: LogLevel, component: string, message: string, data?: unknown): string {
  const timestamp = formatTimestamp();
  const dataStr = formatData(data);
  return `[${timestamp}] [${level.toUpperCase().padEnd(5)}] [${component}] ${message}${dataStr}\n`;
}

export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

export function createLogger(component: string): Logger {
  const log = (level: LogLevel, message: string, data?: unknown): void => {
    if (!LOGGING_ENABLED) return;
    if (LOG_LEVELS[level] < LOG_LEVELS[MIN_LEVEL]) return;

    ensureLogDir();

    const formatted = formatMessage(level, component, message, data);

    // Write to file
    try {
      appendFileSync(LOG_FILE, formatted);
    } catch {
      // Ignore write errors - logging is best-effort
    }

    // Also write to stderr for errors
    if (level === 'error') {
      process.stderr.write(`[justscale] ${formatted}`);
    }
  };

  return {
    debug: (message: string, data?: unknown) => log('debug', message, data),
    info: (message: string, data?: unknown) => log('info', message, data),
    warn: (message: string, data?: unknown) => log('warn', message, data),
    error: (message: string, data?: unknown) => log('error', message, data),
  };
}

// Main logger for the typescript.js module
export const logger = createLogger('typescript');

// Helper to log function calls with timing
export function logCall<T>(
  log: Logger,
  fnName: string,
  fn: () => T,
  args?: Record<string, unknown>,
): T {
  const start = performance.now();
  log.debug(`${fnName} called`, args);

  try {
    const result = fn();
    const duration = (performance.now() - start).toFixed(2);
    log.debug(`${fnName} completed in ${duration}ms`);
    return result;
  } catch (err) {
    const duration = (performance.now() - start).toFixed(2);
    log.error(`${fnName} failed after ${duration}ms`, { error: String(err) });
    throw err;
  }
}
