import JustScale, {
  bindRepository,
  bindService,
  AbstractChannelBackend,
  createConfig,
} from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import {
  createPostgresClient,
  createPostgresChannelBackend,
  PostgresLockFeature,
  PostgresProcessFeature,
  PostgresProcessConfig,
} from '@justscale/postgres';
import { Order } from './domains/order/order.model.js';
import { OrderSignals } from './domains/order/order.signals.js';
import { OrderService } from './domains/order/order.service.js';
// Importing the process registers it via its module side-effect; it is not
// added to the builder.
import './domains/order/order-fulfillment.process.js';
import { OrderRepository } from './infra/pg/order.pg.js';

const defaultConnectionString = `postgres://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/justscale_test`;

// Builds the full Postgres-backed app. Workers and tests share this so a
// process started on one node is resumed by a signal sent from another.
export function buildApp(connectionString: string = process.env.DATABASE_URL ?? defaultConnectionString) {
  const PostgresClient = createPostgresClient({ connectionString });
  const PgChannelBackend = createPostgresChannelBackend({ connectionString });

  const ProcessConfig = createConfig({
    provides: [PostgresProcessConfig],
    factory: () => ({
      [PostgresProcessConfig.key]: { signalChannel: 'order_signals' },
    }),
  });

  const built = (JustScale() as any)
    .add(ProcessConfig)
    .add(PostgresClient)
    .add(PgChannelBackend)
    .add(bindService(AbstractChannelBackend, PgChannelBackend))
    .add(PostgresLockFeature)
    .add(PostgresProcessFeature)
    .add(OrderRepository)
    .add(bindRepository(ModelRepository.of(Order), OrderRepository))
    .add(OrderSignals)
    .add(OrderService)
    .build();

  return { built, PostgresClient };
}
