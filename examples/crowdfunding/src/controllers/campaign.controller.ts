import { createController } from '@justscale/core';
import { Get, Post } from '@justscale/http';
import { ModelRepository } from '@justscale/core/models';
import { permissions, assertNever } from '@justscale/permission';
import { auth, optionalAuth } from '@justscale/auth';
import { Campaign } from '../domain/index.js';
import { CampaignService } from '../services/campaign.service.js';
import {
  CampaignOwnerView,
  CampaignPublicView,
  ErrorResponse,
  CreateCampaignBody,
  AddRewardTierBody,
  AddStretchGoalBody,
} from '../schemas/campaign.js';

export const CampaignController = createController({
  inject: { svc: CampaignService, campaigns: ModelRepository.of(Campaign) },
  routes: ({ svc, campaigns }) => ({
    create: Post('/campaigns')
      .use(auth)
      .body(CreateCampaignBody)
      .handle(async ({ body, res }) => {
        res.json(await svc.create(body));
      }),

    launch: Post('/campaigns/:campaign/launch')
      .types({ Campaign })
      .use(auth)
      .handle(async ({ params, res }) => {
        using campaign = await campaigns.lock(params.campaign);
        if (!campaign) {
          return res.status(404).json({ error: 'Not found' });
        }
        res.json(await svc.launch(campaign));
      }),

    /**
     * GET /campaigns/:campaign — response shape depends on who's asking.
     *
     * - Owning creator (authenticated via session, email matches campaign.creator) → CampaignOwnerView
     * - Anyone else (authenticated or not) → CampaignPublicView
     *
     * `.types({ Campaign })` transforms :campaign into a Reference<Campaign>.
     * `.use(optionalAuth)` populates ctx.user if a valid session is present.
     * `.use(permissions)` resolves principals and matches them against the
     * declaration order of permission-scoped `.returns()`.
     */
    get: Get('/campaigns/:campaign')
      .types({ Campaign })
      .use(optionalAuth)
      .use(permissions)
      .returns(200, CampaignOwnerView, Campaign.can.viewAsOwner)
      .returns(200, CampaignPublicView, Campaign.can.view)
      .returns(404, ErrorResponse)
      .handle(async ({ params, res }) => {
        const campaign = await params.campaign;
        if (!campaign) {
          res.status(404).json({ error: 'Not found' });
          return;
        }

        switch (res.permission) {
          case 'viewAsOwner':
            res.json({
              title: campaign.title,
              description: campaign.description,
              goalAmount: campaign.goalAmount,
              currentAmount: campaign.currentAmount,
              status: campaign.status,
              deadline: campaign.deadline?.toISOString(),
              durationDays: campaign.durationDays,
              imageUrls: campaign.imageUrls,
            });
            return;
          case 'view':
            res.json({
              title: campaign.title,
              description: campaign.description,
              goalAmount: campaign.goalAmount,
              currentAmount: campaign.currentAmount,
              status: campaign.status,
            });
            return;
          default:
            assertNever(res);
        }
      }),

    list: Get('/campaigns')
      .handle(async ({ res }) => {
        res.json(await svc.list());
      }),

    addReward: Post('/campaigns/:campaign/rewards')
      .types({ Campaign })
      .use(auth)
      .body(AddRewardTierBody)
      .handle(async ({ params, body, res }) => {
        res.json(await svc.addRewardTier(params.campaign, body));
      }),

    addStretchGoal: Post('/campaigns/:campaign/stretch-goals')
      .types({ Campaign })
      .use(auth)
      .body(AddStretchGoalBody)
      .handle(async ({ params, body, res }) => {
        res.json(await svc.addStretchGoal(params.campaign, body));
      }),
  }),
});
