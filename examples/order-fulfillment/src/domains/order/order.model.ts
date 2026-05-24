import { defineModel, field } from '@justscale/core/models';

export class Order extends defineModel({
  name: 'Order',
  fields: {
    customerEmail: field.string().max(255),
    amount: field.decimal(10, 2),
    status: field
      .enum('OrderStatus', ['awaiting_payment', 'fulfilled', 'cancelled'] as const)
      .default('awaiting_payment'),
  },
}) {}
