import { createPgModel, createPgRepository } from '@justscale/postgres';
import { PaymentTransaction } from '../../domain/payment-transaction.js';

export const PgPaymentTransaction = createPgModel(PaymentTransaction, {
  table: 'payment_transactions',
  relations: {
    pledge: { onDelete: 'RESTRICT' },
  },
  indexes: [
    { fields: ['pledgeId'], name: 'idx_payment_transactions_pledge' },
    { fields: ['status'], name: 'idx_payment_transactions_status' },
  ],
});

export const PaymentTransactionRepository = createPgRepository(PgPaymentTransaction);
