import { createPgModel, createPgRepository } from '@justscale/postgres';
import { Order } from '../../domains/order/order.model.js';

export const PgOrder = createPgModel(Order, {
  table: 'orders',
  overrides: { status: { index: true } },
});

export const OrderRepository = createPgRepository(PgOrder);
