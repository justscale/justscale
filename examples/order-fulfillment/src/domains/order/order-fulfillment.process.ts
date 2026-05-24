import { createProcess, delay, race, signal } from '@justscale/core/process';
import { ModelRepository, type Ref } from '@justscale/core/models';
import { Order } from './order.model.js';
import { OrderService } from './order.service.js';

type OrderRepo = InstanceType<typeof ModelRepository<Order>>;

async function setStatus(
  repo: OrderRepo,
  svc: OrderService,
  ref: Ref<Order>,
  status: 'fulfilled' | 'cancelled',
): Promise<void> {
  using locked = await repo.lock(ref);
  if (!locked) return;
  if (status === 'fulfilled') await svc.markFulfilled(locked);
  else await svc.markCancelled(locked);
}

// Place an order, then race a payment-confirmed signal against a 15 minute
// timeout. Payment wins -> fulfilled. Timeout wins -> cancelled. The whole
// thing is Postgres-backed: a process started on one node is resumed by a
// signal sent from another node.
export const orderFulfillment = createProcess({
  path: '/order/:order/fulfillment',
  types: { order: Order },
  inject: { orders: OrderService, repo: ModelRepository.of(Order) },
  async handler({ orders, repo }, { order }) {
    const r = race();
    switch (true) {
      case signal(r, orders.paymentConfirmed):
        await setStatus(repo, orders, order, 'fulfilled');
        return { status: 'fulfilled' as const };
      case delay.minutes(r, 15):
        await setStatus(repo, orders, order, 'cancelled');
        return { status: 'cancelled' as const };
    }
  },
});
