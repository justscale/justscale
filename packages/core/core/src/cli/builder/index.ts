/**
 * CLI Builder Module
 *
 * Exports CLI-specific route builder types and factories.
 */

export type {
  CliRouteBuilder,
  CliRouteDef,
  CliMethod,
  CliBaseContext,
} from './types.js';

export {
  createCliRouteBuilder,
  Cli,
  INPUT_SCHEMA,
  getInputSchema,
} from './create-cli-builder.js';
