import { defineService } from '@justscale/core';
import { ModelRepository, type Locked, type Persistent } from '@justscale/core/models';
import { PaymentTransaction, Pledge } from '../domain/index.js';
import { PaymentSignals } from './signals.js';

export class PaymentService extends defineService({
  inject: {
    transactions: ModelRepository.of(PaymentTransaction),
    pledges: ModelRepository.of(Pledge),
    signals: PaymentSignals,
  },
  factory: ({ transactions, pledges, signals }) => {
    const svc = {
      get chargeProcessed() { return signals.chargeProcessed; },
      get refundProcessed() { return signals.refundProcessed; },

      async charge(pledge: Locked<Pledge>): Promise<Persistent<PaymentTransaction>> {
        const tx = await transactions.insert({
          pledge,
          type: 'charge',
          amount: pledge.amount,
          status: 'success',
          externalId: `ch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          processedAt: new Date(),
        });

        await pledges.update(pledge, {
          status: 'charged',
          chargedAt: new Date(),
        });

        return tx;
      },

      async refund(pledge: Locked<Pledge>): Promise<Persistent<PaymentTransaction>> {
        const tx = await transactions.insert({
          pledge,
          type: 'refund',
          amount: pledge.amount,
          status: 'success',
          externalId: `rf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          processedAt: new Date(),
        });

        await pledges.update(pledge, {
          status: 'refunded',
          refundedAt: new Date(),
        });

        return tx;
      },
    };
    return svc;
  },
}) {}
