import {
  createProcess,
  delay,
  race,
  signal,
} from '@justscale/core/process';
import {
  ModelRepository,
  type Persistent,
  type Ref,
} from '@justscale/core/models';
import { Campaign, Pledge } from '../domain/index.js';
import { CampaignService } from '../services/campaign.service.js';
import { PledgeService } from '../services/pledge.service.js';
import { PaymentService } from '../services/payment.service.js';

type CampaignRepo = InstanceType<typeof ModelRepository<Campaign>>;
type PledgeRepo = InstanceType<typeof ModelRepository<Pledge>>;
type Payments = {
  charge: (locked: Parameters<PaymentService['charge']>[0]) => Promise<unknown>;
  refund: (locked: Parameters<PaymentService['refund']>[0]) => Promise<unknown>;
};

async function setCampaignStatus(
  repo: CampaignRepo,
  svc: CampaignService,
  ref: Ref<Campaign>,
  status: Persistent<Campaign>['status'],
): Promise<void> {
  using locked = await repo.lock(ref);
  if (locked) await svc.updateStatus(locked, status);
}

async function chargePledgeById(
  pledgeRepo: PledgeRepo,
  payments: Payments,
  pledgeId: string,
): Promise<void> {
  using locked = await pledgeRepo.lock(Pledge.ref(pledgeId));
  if (locked) await payments.charge(locked);
}

async function refundPledgeById(
  pledgeRepo: PledgeRepo,
  payments: Payments,
  pledgeId: string,
): Promise<void> {
  using locked = await pledgeRepo.lock(Pledge.ref(pledgeId));
  if (locked) await payments.refund(locked);
}

export const campaignLifecycle = createProcess({
  path: '/campaign/:campaign/lifecycle',
  types: { Campaign },
  inject: {
    campaigns: CampaignService,
    pledges: PledgeService,
    payments: PaymentService,
    campaignRepo: ModelRepository.of(Campaign),
    pledgeRepo: ModelRepository.of(Pledge),
  },

  async handler(
    { campaigns, pledges, payments, campaignRepo, pledgeRepo },
    { campaign },
  ) {
    const found = await campaign;
    if (!found) {
      return { status: 'failed', reason: 'Campaign not found' };
    }

    const r = race();
    switch (true) {
      case signal(r, pledges.fullyFunded): {
        await setCampaignStatus(campaignRepo, campaigns, campaign, 'settling');

        const pledgeIds = await pledges.findIds(campaign);
        for (const pledgeId of pledgeIds) {
          await chargePledgeById(pledgeRepo, payments, pledgeId);
          await signal(payments.chargeProcessed);
        }

        await setCampaignStatus(campaignRepo, campaigns, campaign, 'completed');
        await campaigns.checkStretchGoals(campaign, String(found.currentAmount));
        return { status: 'completed', campaign: found };
      }

      case delay.days(r, found.durationDays): {
        await setCampaignStatus(campaignRepo, campaigns, campaign, 'failed');

        const refundPledgeIds = await pledges.findIds(campaign);
        for (const pledgeId of refundPledgeIds) {
          await refundPledgeById(pledgeRepo, payments, pledgeId);
          await signal(payments.refundProcessed);
        }
        return { status: 'failed', campaign: found };
      }
    }
  },
});
