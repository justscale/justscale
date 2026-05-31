import { buildProviders, createEnvironment, EnvVarVault } from '@justscale/core';
import { httpEnv } from '@justscale/http';
import {
  postgresProcessEnv,
  postgresMigrationEnv,
  postgresSecret,
} from '@justscale/postgres';
import { type AppEnv, appEnv, userFlagsEnv } from '../src/env-contract.js';

export default createEnvironment<AppEnv>({
  name: 'production',
  type: 'production',
  services: [EnvVarVault],
  providers: buildProviders([
    appEnv({ siteUrl: process.env.SITE_URL ?? 'https://example.com', logLevel: 'warn' }),
    httpEnv({ port: Number(process.env.HTTP_PORT ?? 6242) }),
    postgresProcessEnv(process.env.SIGNAL_CHANNEL ? { signalChannel: process.env.SIGNAL_CHANNEL } : {}),
    postgresMigrationEnv(),
    postgresSecret('database/url'),
    userFlagsEnv(),
  ]),
});
