/**
 * Pglite-backed Postgres feature - **dev/test only**.
 *
 * Boots an in-process PGlite instance (WASM Postgres), exposes it via a
 * Unix socket speaking the Postgres wire protocol, and provides an
 * `AbstractPostgresClient` pointed at that socket. From the rest of the
 * code's perspective it's just another Postgres - same `postgres.js`
 * driver, same connection pool, same transaction / session-scoped lock
 * semantics. No sql-template shim, no parallel driver stack.
 *
 * LISTEN/NOTIFY is NOT forwarded through pglite-socket today, so dev
 * compositions that need `AbstractChannelBackend` should override it
 * separately (e.g. via an in-memory backend). `PostgresChannelFeature`
 * should NOT be added when using `PgliteFeature`.
 *
 * Intended for `@justscale/postgres/dev` consumers only. Do not import
 * from the main `@justscale/postgres` entry.
 *
 * @example
 * ```ts
 * // src/dev.ts
 * import { defineApp, bindService } from '@justscale/core';
 * import { InMemoryChannelBackend, AbstractChannelBackend } from '@justscale/core/memory';
 * import { PgliteFeature } from '@justscale/postgres/dev';
 * import makeApp from './app.js';
 *
 * export default defineApp(import.meta, async (env) =>
 *   (await makeApp(env))
 *     .add(PgliteFeature)
 *     .add(bindService(AbstractChannelBackend, InMemoryChannelBackend)),
 * );
 * ```
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Lifecycle,
  Logger,
  bindService,
  createFeatureBuilder,
  defineService,
} from '@justscale/core';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { AbstractPostgresClient, createRawPostgresClient } from '../client/client.js';

/**
 * Postgres.js follows the conventional Unix-socket layout: given a
 * `path` directory and `port`, it connects to `<path>/.s.PGSQL.<port>`.
 * We create a per-instance directory and drop the socket inside it so
 * several pglite instances can coexist in the same process without
 * name collisions.
 */
function ephemeralSocketDir(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `pglite-${process.pid}-${rand}`);
}

const PGLITE_SOCKET_PORT = 5432;

/**
 * PgliteClientService: boot pglite + socket, connect postgres.js, hand
 * back an `AbstractPostgresClient`. Registers Lifecycle('stop') hooks
 * to tear down the socket server and close pglite on shutdown.
 */
const PgliteClientService = defineService({
  inject: { logger: Logger, lifecycle: Lifecycle },
  provides: [AbstractPostgresClient],
  factory: async ({ logger, lifecycle }) => {
    const sockDir = ephemeralSocketDir();
    await mkdir(sockDir, { recursive: true });
    const sockPath = join(sockDir, `.s.PGSQL.${PGLITE_SOCKET_PORT}`);

    const pg = await PGlite.create();
    const server = new PGLiteSocketServer({
      db: pg,
      path: sockPath,
    });
    await server.start();
    logger.info(`[pglite] in-memory postgres listening on ${sockPath}`);

    lifecycle.register('stop', async () => {
      try {
        await server.stop();
      } catch (err) {
        logger.warn(`[pglite] socket server stop failed: ${String(err)}`);
      }
      try {
        await pg.close();
      } catch (err) {
        logger.warn(`[pglite] pglite close failed: ${String(err)}`);
      }
      try {
        await rm(sockDir, { recursive: true, force: true });
      } catch {
        // socket dir may already be gone
      }
    });

    return createRawPostgresClient(
      {
        host: sockDir,
        port: PGLITE_SOCKET_PORT,
        database: 'postgres',
        username: 'postgres',
      },
      logger,
    );
  },
});

/**
 * Feature that swaps `AbstractPostgresClient` for a pglite-backed
 * client. Dev compositions add this on top of the production
 * composition (which provides the real Postgres client); the
 * `bindService` override wins.
 *
 * Does **not** touch `AbstractChannelBackend`. Apps that need channels
 * in dev should add `bindService(AbstractChannelBackend, ...)` with an
 * in-memory implementation - pglite-socket doesn't forward NOTIFY.
 */
export const PgliteFeature = createFeatureBuilder()
  .name('Pglite')
  .requires(Logger)
  .requires(Lifecycle)
  .provides((b) =>
    b
      .add(PgliteClientService)
      .add(bindService(AbstractPostgresClient, PgliteClientService)),
  );
