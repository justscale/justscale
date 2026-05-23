import { createController } from '@justscale/core';
import { Cli } from '@justscale/core/cli';
import { AbstractPostgresClient } from './client/client.js';

export const PgCliController = createController({
  inject: {
    pg: AbstractPostgresClient,
  },
  routes: ({ pg }) => ({
    status: Cli('pg status')
      .handle(async (ctx) => {
        try {
          const result = await pg.pool`SELECT version(), current_database(), inet_server_addr() as host, inet_server_port() as port`;
          const row = result[0];
          ctx.io.log(`Database: ${row.current_database}`);
          ctx.io.log(`Host:     ${row.host ?? 'localhost'}:${row.port ?? 5432}`);
          ctx.io.log(`Version:  ${row.version}`);
        } catch (err: any) {
          ctx.io.error(`Connection failed: ${err.message}`);
        }
      }),
  }),
});
