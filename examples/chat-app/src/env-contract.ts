/**
 * App env contract.
 *
 * Defines the full set of config/secrets/flags partials this app requires.
 * Every `env/*.ts` composes against `AppEnv` so a missing partial surfaces
 * as a TS error at env-definition time rather than at runtime.
 */

import { z } from 'zod';
import {
  config,
  defineConfigPartial,
  defineFeatureFlagPartial,
  flag,
  type EnvContract,
} from '@justscale/core';
import { HttpConfig } from '@justscale/http';
import {
  PostgresSecrets,
  PostgresProcessConfig,
  PostgresMigrationConfig,
  PostgresMigrationDevConfig,
} from '@justscale/postgres';

export const AppConfig = defineConfigPartial('app', z.object({
  siteUrl: z.string().default('http://localhost:6242'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}));

export const UserFlags = defineFeatureFlagPartial('user', z.object({
  autoVerify: z.boolean().default(false),
}));

export const appEnv = (overrides: Partial<z.infer<typeof AppConfig.schema>> = {}) =>
  config(AppConfig, overrides);

export const userFlagsEnv = (overrides: Partial<z.infer<typeof UserFlags.schema>> = {}) =>
  flag(UserFlags, overrides);

export type AppEnv = EnvContract<{
  config: readonly [
    typeof AppConfig,
    typeof HttpConfig,
    typeof PostgresProcessConfig,
    typeof PostgresMigrationConfig,
    typeof PostgresMigrationDevConfig,
  ];
  secrets: readonly [typeof PostgresSecrets];
  flags: readonly [typeof UserFlags];
}>;
