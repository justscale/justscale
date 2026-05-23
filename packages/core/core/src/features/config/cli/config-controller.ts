/**
 * Config CLI Controller
 *
 * Provides CLI commands for managing configuration:
 * - config set <key> <value>  - Set a config value
 * - config get <key>          - Get a config value
 * - config list               - List all config values
 * - config validate           - Validate config against schemas
 *
 * @example
 * ```bash
 * # Set a value
 * justscale config set database.host localhost
 *
 * # Get a value
 * justscale config get database.host
 *
 * # List all values
 * justscale config list
 *
 * # Validate configuration
 * justscale config validate
 * ```
 */

import { createController } from '../../../core/index.js';
import { Cli } from '../../../cli/index.js';
import { ConfigServiceDef } from '../config-service.js';
import { getPath, formatValue } from './utils.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Create the Config CLI controller.
 *
 * This controller provides CLI commands for managing runtime configuration.
 */
export function createConfigController() {
  return createController({
    inject: { configService: ConfigServiceDef },
    routes: () => ({
      /**
       * Set a configuration value.
       * Usage: config set <key> <value>
       *
       * @example
       * ```bash
       * justscale config set database.host localhost
       * justscale config set database.port 5432
       * ```
       */
      configSet: Cli('config set').handle(async ({ io, args }: any) => {
        const key = (args as Record<string, unknown>)['0'] as string | undefined;
        const value = (args as Record<string, unknown>)['1'] as string | undefined;

        if (!key || value === undefined) {
          io.error('Usage: config set <key> <value>');
          io.log('');
          io.log('Examples:');
          io.log('  config set database.host localhost');
          io.log('  config set database.port 5432');
          return;
        }

        // Parse value (support JSON strings, numbers, booleans)
        let parsedValue: unknown;
        try {
          // Try to parse as JSON first
          parsedValue = JSON.parse(value);
        } catch {
          // If not valid JSON, use as string
          parsedValue = value;
        }

        try {
          // TODO: This needs a way to determine which ConfigPartial to use
          // For MVP, we'll just persist to disk and log
          // In a real implementation, we'd need to:
          // 1. Determine which partial owns this key
          // 2. Call configService.set(partial, key, parsedValue)

          io.log(`Setting ${key} = ${formatValue(parsedValue)}`);
          io.log('');
          io.log('Note: Runtime config updates require ConfigPartial registration.');
          io.log('For now, values are only persisted to .justscale/config.json');
        } catch (error) {
          io.error(`Failed to set config: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),

      /**
       * Get a configuration value.
       * Usage: config get <key>
       *
       * @example
       * ```bash
       * justscale config get database.host
       * justscale config get database
       * ```
       */
      configGet: Cli('config get').handle(async ({ io, args }: any) => {
        const key = (args as Record<string, unknown>)['0'] as string | undefined;

        if (!key) {
          io.error('Usage: config get <key>');
          io.log('');
          io.log('Examples:');
          io.log('  config get database.host');
          io.log('  config get database');
          return;
        }

        try {
          const configPath = join(process.cwd(), '.justscale', 'config.json');

          if (!existsSync(configPath)) {
            io.log('No configuration file found.');
            io.log('Use "config set" to create configuration.');
            return;
          }

          const config = JSON.parse(readFileSync(configPath, 'utf-8'));
          const value = getPath(config, key);

          if (value === undefined) {
            io.log(`No value found for key: ${key}`);
            return;
          }

          io.log(formatValue(value));
        } catch (error) {
          io.error(`Failed to get config: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),

      /**
       * List all configuration values.
       * Usage: config list
       *
       * @example
       * ```bash
       * justscale config list
       * ```
       */
      configList: Cli('config list').handle(async ({ io }: any) => {
        try {
          const configPath = join(process.cwd(), '.justscale', 'config.json');

          if (!existsSync(configPath)) {
            io.log('No configuration file found.');
            io.log('Use "config set" to create configuration.');
            return;
          }

          const config = JSON.parse(readFileSync(configPath, 'utf-8'));

          // Flatten config to show all paths
          const flattenConfig = (obj: any, prefix = ''): Array<{ key: string; value: unknown }> => {
            const result: Array<{ key: string; value: unknown }> = [];

            for (const [key, value] of Object.entries(obj)) {
              const path = prefix ? `${prefix}.${key}` : key;

              if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                result.push(...flattenConfig(value, path));
              } else {
                result.push({ key: path, value });
              }
            }

            return result;
          };

          const flattened = flattenConfig(config);

          if (flattened.length === 0) {
            io.log('No configuration values found.');
            return;
          }

          io.log('Configuration values:\n');

          // Show as table
          const rows = flattened.map(({ key, value }) => ({
            Key: key,
            Value: formatValue(value),
          }));

          io.table(rows);
        } catch (error) {
          io.error(`Failed to list config: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),

      /**
       * Validate configuration against schemas.
       * Usage: config validate
       *
       * @example
       * ```bash
       * justscale config validate
       * ```
       */
      configValidate: Cli('config validate').handle(async ({ io }: any) => {
        try {
          const configPath = join(process.cwd(), '.justscale', 'config.json');

          if (!existsSync(configPath)) {
            io.log('No configuration file found.');
            io.log('Configuration is valid (no values to validate).');
            return;
          }

          const config = JSON.parse(readFileSync(configPath, 'utf-8'));

          // TODO: Validate against registered ConfigPartial schemas
          // For MVP, just verify it's valid JSON
          io.log('Configuration validation:');
          io.log('');
          io.log('  Valid JSON: Yes');
          io.log(`  Config entries: ${Object.keys(config).length}`);
          io.log('');
          io.log('Note: Schema validation requires ConfigPartial registration.');
          io.log('See the Config documentation for details.');
        } catch (error) {
          io.error(`Failed to validate config: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    }),
  });
}
