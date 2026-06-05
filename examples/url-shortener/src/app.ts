import JustScale, { bindRepository, createConfig, createSecretProvider } from '@justscale/core';
import { HttpConfig } from '@justscale/http';
import { ModelRepository } from '@justscale/core/models';
import { PostgresFeature, PostgresChannelFeature, PostgresSecrets } from '@justscale/postgres';

import { Link } from './domains/link/link.model.js';
import { LinkService } from './domains/link/link.service.js';
import { LinkRepository } from './infra/pg/link.pg.js';
import { LinkController } from './controllers/link.controller.js';

const DEFAULT_CONNECTION_STRING =
  process.env.DATABASE_URL ??
  `postgres://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/justscale_links`;

const Config = createConfig({
  provides: [HttpConfig],
  factory: () => ({
    [HttpConfig.key]: { port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' },
  }),
});

// Bootstrap wires the concrete adapters. The domain (model + service) is
// unaware any of this exists - swap the repository and nothing above changes.
export function createApp(connectionString = DEFAULT_CONNECTION_STRING) {
  const Secrets = createSecretProvider({
    provides: [PostgresSecrets],
    factory: () => ({ [PostgresSecrets.key]: { connectionString } }),
  });
  return JustScale()
    .add(Secrets)
    .add(Config)
    .add(PostgresFeature)
    .add(PostgresChannelFeature)
    .add(LinkRepository)
    .add(bindRepository(ModelRepository.of(Link), LinkRepository))
    .add(LinkService)
    .add(LinkController)
    .build();
}

export const app = createApp();
