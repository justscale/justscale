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
  name: 'local',
  type: 'development',
  public: { siteUrl: 'http://localhost:6242' },
  services: [
    HardcodedVault({
      'postgres/url': process.env.DATABASE_URL
        ?? `postgres://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/chat_app`,
    }),
  ],
  providers: buildProviders([
    appEnv({ logLevel: 'debug' }),
    httpEnv({ port: Number(process.env.PORT ?? 6242) }),
    postgresProcessEnv(process.env.SIGNAL_CHANNEL ? { signalChannel: process.env.SIGNAL_CHANNEL } : {}),
    postgresMigrationEnv(),
    postgresMigrationDevEnv(),
    postgresSecret('postgres/url'),
    userFlagsEnv({ autoVerify: true }),
  ]),
});
