import { defineService } from '@justscale/core';
import { ModelRepository, type Locked, type Persistent, type Ref } from '@justscale/core/models';
import { Order } from './order.model.js';
import { OrderSignals } from './order.signals.js';

export class OrderService extends defineService({
  inject: {
    orders: ModelRepository.of(Order),
    signals: OrderSignals,
  },
  factory: ({ orders, signals }) => {
    return {
      // Re-export the signal so the process and callers reference it via the service.
      get paymentConfirmed() {
        return signals.paymentConfirmed;
      },

      async place(input: { customerEmail: string; amount: string }): Promise<Persistent<Order>> {
        return orders.insert({
          customerEmail: input.customerEmail,
          amount: input.amount,
          status: 'awaiting_payment',
        });
      },

      get(order: Ref<Order>): Promise<Persistent<Order> | undefined> {
        return orders.get(order);
      },

      async markFulfilled(order: Locked<Order>): Promise<Persistent<Order>> {
        return orders.update(order, { status: 'fulfilled' });
      },

      async markCancelled(order: Locked<Order>): Promise<Persistent<Order>> {
        return orders.update(order, { status: 'cancelled' });
      },

      // No lock held: we only need the ref to route the signal. The signal
      // triggers orderFulfillment, which re-locks the same order; holding a
      // lock across the emit would deadlock against ourselves. Cast through
      // the Locked-typed payload because signal identity uses .identifier at
      // runtime regardless of the typed shape.
      async confirmPayment(order: Ref<Order>): Promise<void> {
        await signals.paymentConfirmed({ order: order as unknown as Locked<Order> });
      },
    };
  },
}) {}
