import { defineSignals } from '@justscale/core/process';
import { Campaign } from '../domain/index.js';

// Param name :campaign matches the campaignLifecycle process's path param
// so that signal subscription identity aligns with process identity.
export class PledgeSignals extends defineSignals(signal => ({
  /** Fired when a pledge is made */
  pledged: signal('/pledge/:campaign/pledged')
    .types({ Campaign }),

  /** Fired when a pledge is cancelled */
  cancelled: signal('/pledge/:campaign/cancelled')
    .types({ Campaign }),

  /** Fired when a campaign reaches its funding goal */
  fullyFunded: signal('/pledge/:campaign/fully-funded')
    .types({ Campaign }),
})) {}

export class PaymentSignals extends defineSignals(signal => ({
  /** Fired when a charge completes */
  chargeProcessed: signal('/payment/:campaign/charge-processed')
    .types({ Campaign }),

  /** Fired when a refund completes */
  refundProcessed: signal('/payment/:campaign/refund-processed')
    .types({ Campaign }),
})) {}
