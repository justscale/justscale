import { createController } from '@justscale/core';
import { Delete, Get, Post } from '@justscale/http';
import { ModelRepository } from '@justscale/core/models';
import { Campaign, Pledge } from '../domain/index.js';
import { PledgeService } from '../services/pledge.service.js';
import { CreatePledgeBody } from '../schemas/campaign.js';

export const PledgeController = createController({
  inject: { pledge: PledgeService, pledges: ModelRepository.of(Pledge), campaigns: ModelRepository.of(Campaign) },
  routes: (services) => [
    Post('/campaigns/:campaign/pledge')
      .types({ Campaign })
      .body(CreatePledgeBody)
      .handle(async ({ params, body, res }) => {
        using campaign = await services.campaigns.lock(params.campaign);
        if (!campaign) {
          return res.status(404).json({ error: 'Campaign not found' });
        }
        res.json(await services.pledge.pledge(
          campaign,
          body.backer,
          body.amount,
          body.rewardTier,
        ));
      }),

    Delete('/pledges/:pledge')
      .types({ Pledge })
      .handle(async ({ params, res }) => {
        using pledge = await services.pledges.lock(params.pledge);
        if (!pledge) {
          return res.status(404).json({ error: 'Not found' });
        }

        using campaign = await services.campaigns.lock(pledge.campaign);
        if (!campaign) {
          return res.status(404).json({ error: 'Campaign not found' });
        }

        res.json(await services.pledge.cancel(pledge, campaign));
      }),

    Get('/campaigns/:campaign/pledges')
      .types({ Campaign })
      .handle(async ({ params, res }) => {
        const iter = services.pledge.iterate({
          where: Pledge.fields.campaign.eq(params.campaign),
          orderBy: { createdAt: 'desc' },
        });
        const result = [];
        for await (const pledge of iter) {
          result.push(pledge);
        }
        res.json(result);
      }),
  ],
});
