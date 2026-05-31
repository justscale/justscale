/**
 * Order Fulfillment Process
 *
 * A durable process that handles the order lifecycle:
 * - Wait for payment confirmation
 * - Wait for order to be shipped
 * - Wait for delivery confirmation or timeout
 *
 * This process survives server restarts and can wait for days/weeks.
 */

import { defineService } from '@justscale/core';
import type { Ref } from '@justscale/core/models';
import {
  createProcess,
  defineSignals,
  delay,
  race,
  signal,
} from '@justscale/core/process';
import { Order } from '../models/index.js';
import { OrderRepository } from '../models/pg-models.js';

// ============================================================================
// Signals - Events that can wake up the process
// ============================================================================

// Signal groups — defined with the new defineSignals API
export class PaymentSignals extends defineSignals(signal => ({
  confirmed: signal('/payment/:order/confirmed')
    .types({ Order }),
  failed: signal('/payment/:order/failed')
    .data<{ reason: string }>()
    .types({ Order }),
})) {}

export class ShippingSignals extends defineSignals(signal => ({
  shipped: signal('/shipping/:order/shipped')
    .data<{ trackingNumber: string }>()
    .types({ Order }),
  delivered: signal('/shipping/:order/delivered')
    .types({ Order }),
})) {}

// Services — just for finding orders (the old PaymentService and ShippingService
// were mostly signal holders; keeping the findOrder helpers for compatibility)
export class PaymentService extends defineService({
  inject: { orders: OrderRepository, signals: PaymentSignals },
  factory: ({ orders, signals }) => ({
    findOrder: (order: Ref<Order>) => orders.get(order),
    get confirmed() { return signals.confirmed; },
    get failed() { return signals.failed; },
  }),
}) {}

export class ShippingService extends defineService({
  inject: { orders: OrderRepository, signals: ShippingSignals },
  factory: ({ orders, signals }) => ({
    findOrder: (order: Ref<Order>) => orders.get(order),
    get shipped() { return signals.shipped; },
    get delivered() { return signals.delivered; },
  }),
}) {}

// ============================================================================
// Process Definition
// ============================================================================

export const orderFulfillment = createProcess({
  path: '/order/:order/fulfillment',
  types: { Order },
  inject: {
    payment: PaymentService,
    shipping: ShippingService,
  },

  async handler({ payment, shipping }, { order }) {
    // Fetch order - ref resolves via async context
    using found = await order;
    if (!found) {
      return { status: 'failed', reason: 'Order not found' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Wait for payment (with timeout)
    // ─────────────────────────────────────────────────────────────────────────

    switch (await race()) {
      case await signal(payment.confirmed):
        // Payment received, continue to shipping
        break;

      case await signal(payment.failed):
        return { status: 'payment_failed', order: found };

      case await delay.days(3):
        // No payment after 3 days - cancel order
        return { status: 'payment_timeout', order: found };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Wait for shipping
    // ─────────────────────────────────────────────────────────────────────────

    const shipment = await signal(shipping.shipped);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Wait for delivery (with long timeout)
    // ─────────────────────────────────────────────────────────────────────────

    switch (await race()) {
      case await signal(shipping.delivered):
        return {
          status: 'completed',
          order: found,
          trackingNumber: shipment.trackingNumber,
        };

      case await delay.days(30):
        return {
          status: 'delivery_timeout',
          order: found,
          trackingNumber: shipment.trackingNumber,
        };
    }
  },
});
