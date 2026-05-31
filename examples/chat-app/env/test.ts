import { buildProviders, createEnvironment, HardcodedVault } from '@justscale/core';
import { httpEnv } from '@justscale/http';
import {
  postgresProcessEnv,
  postgresMigrationEnv,
  postgresMigrationDevEnv,
  postgresSecret,
} from '@justscale/postgres';
import { type AppEnv, appEnv, userFlagsEnv } from '../src/env-contract.js';

export default createEnvironment<AppEnv>({
  name: 'test',
  type: 'test',
  services: [
    HardcodedVault({
      'postgres/url': `postgres://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/chat_app_test`,
    }),
  ],
  providers: buildProviders([
    appEnv({ siteUrl: 'http://localhost:3998', logLevel: 'warn' }),
    httpEnv({ port: 3998 }),
    postgresProcessEnv({ signalChannel: `chat_app_test_${process.pid}` }),
    postgresMigrationEnv(),
    postgresMigrationDevEnv(),
    postgresSecret('postgres/url'),
    userFlagsEnv({ autoVerify: true }),
  ]),
});
