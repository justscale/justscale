import { defineModel, field } from '@justscale/core/models';
import { Pledge } from './pledge.js';

export class PaymentTransaction extends defineModel({
  fields: {
    pledge: field.ref(Pledge),
    type: field.enum('TransactionType', ['charge', 'refund'] as const),
    amount: field.decimal(10, 2),
    status: field.enum('TransactionStatus', [
      'pending', 'success', 'failed',
    ] as const).default('pending'),
    externalId: field.string().max(255).optional(),
    processedAt: field.timestamp().optional(),
    createdAt: field.createdAt(),
  },
}) {}
