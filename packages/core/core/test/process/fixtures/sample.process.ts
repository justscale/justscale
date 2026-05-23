/**
 * Sample process with models and repository
 */
import { defineService } from '@justscale/core';
import { defineModel, field, ModelRepository } from '@justscale/core/models';
import { createProcess, AbstractProcessExecutor, signal } from '@justscale/core/process';

// ============================================================================
// Models
// ============================================================================

class Order extends defineModel({
  customerId: field.string(),
  total: field.decimal(10, 2),
  status: field.string().default('pending'),
}) {}

class Payment extends defineModel({
  orderId: field.string(),
  transactionId: field.string(),
  amount: field.decimal(10, 2),
}) {}

// ============================================================================
// Services
// ============================================================================

export class OrderService extends defineService({
  inject: { orders: ModelRepository.of(Order), executor: AbstractProcessExecutor },
  factory: ({ orders, executor }) => ({
    findById: (id: string) => orders.get(Order.ref(id)),
    // Signal: process waits for this, external code calls it
    complete: executor.createSignal<[orderId: string]>('orders.complete'),
  }),
}) {}

export class PaymentService extends defineService({
  inject: { payments: ModelRepository.of(Payment) },
  factory: ({ payments }) => ({
    async charge(orderId: string, amount: number) {
      const payment = new Payment({
        orderId,
        amount: amount.toString(),
        transactionId: `txn_${Date.now()}`,
      });
      return payments.insert(payment);
    },
  }),
}) {}

// ============================================================================
// Process
// ============================================================================

export const orderFulfillment = createProcess({
  path: '/order/:orderId/fulfillment',
  inject: {
    orders: OrderService,
    payments: PaymentService,
  },
  async handler({ orders, payments }, { orderId }) {
    // Fetch order - will be rehydrated if process resumes
    using order = await orders.findById(orderId);
    if (!order) return { status: 'error' as const, message: `Order ${orderId} not found` };

    // Charge payment
    using payment = await payments.charge(orderId, Number(order.total));

    // Suspend until order is marked complete (e.g., shipped)
    await signal(orders.complete);

    return {
      orderId,
      transactionId: payment.transactionId,
      total: order.total,
    };
  },
});
