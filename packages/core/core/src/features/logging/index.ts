/**
 * Logging bindings - swap the default LoggerFactory through the normal
 * `.add()` DI path, and expose logger settings via the config service.
 *
 * ```typescript
 * // Default (zero config): env-seeded pino, JSON to stdout.
 * JustScale().add(MyController).build()
 *
 * // Configured pino + direct Loki push:
 * JustScale()
 *   .add(pinoLoggerFactory({ base: { service: 'api' }, loki: { host: 'http://loki:3100' } }))
 *   .add(MyController)
 *   .build()
 *
 * // Opt out of pino entirely:
 * JustScale().add(consoleLoggerFactory()).add(MyController).build()
 * ```
 *
 * Settings precedence (lowest to highest): environment variables, the
 * explicit `pinoLoggerFactory({...})` argument, then the `justscale.logger`
 * config partial (config.json / `just config set`). The config value wins so
 * an operator can tune logging without touching code; it is read at boot.
 */

import { z } from 'zod';
import { defineService } from '../../core/service.js';
import { LoggerFactory, ConsoleLoggerFactory } from '../../core/logger.js';
import {
  PinoLoggerFactory,
  loggerConfigFromEnv,
  type PinoLoggerConfig,
} from '../../core/pino-logger.js';
import { defineConfigPartial } from '../config/define-config-partial.js';
import { Config } from '../config/config-of.js';

/**
 * Config partial for logger settings. Inject/override via the config service:
 * `just config set justscale.logger.level debug`.
 */
export const loggerConfig = defineConfigPartial(
  'justscale.logger',
  z
    .object({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional(),
      format: z.enum(['json', 'pretty']).optional(),
      redact: z.array(z.string()).optional(),
      base: z.record(z.string(), z.unknown()).optional(),
      loki: z
        .object({
          host: z.string(),
          labels: z.record(z.string(), z.string()).optional(),
          basicAuth: z
            .object({ username: z.string(), password: z.string() })
            .optional(),
          interval: z.number().optional(),
        })
        .optional(),
    })
    .partial()
);

/**
 * Register a pino-backed LoggerFactory. Reads the `justscale.logger` config
 * partial (if set) so operators can tune level / Loki target at boot without
 * code changes.
 *
 * The partial is read through the resolver, NOT declared as an inject dep, so
 * this factory can be `.add()`ed on its own without forcing the app to also
 * provide the config partial. When the partial is unset the resolver returns
 * undefined and the env + explicit-argument config applies.
 */
export function pinoLoggerFactory(config: PinoLoggerConfig = {}) {
  return defineService({
    inject: {},
    provides: [LoggerFactory],
    factory: async (_deps, resolve) => {
      const cfg = (await resolve(Config.of(loggerConfig) as never).catch(
        () => undefined
      )) as PinoLoggerConfig | undefined;
      return new PinoLoggerFactory({
        ...loggerConfigFromEnv(),
        ...config,
        ...(cfg ?? {}),
      });
    },
  });
}

/** Register the zero-dependency ConsoleLogger backend instead of pino. */
export function consoleLoggerFactory() {
  return defineService({
    inject: {},
    provides: [LoggerFactory],
    factory: () => new ConsoleLoggerFactory(),
  });
}
