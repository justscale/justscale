import { createController } from '@justscale/core';
import { Get, Post } from '@justscale/http';
import { Backer } from '../domain/index.js';
import { BackerService } from '../services/backer.service.js';
import { RegisterBackerBody } from '../schemas/campaign.js';

export const BackerController = createController({
  inject: { svc: BackerService },
  routes: ({ svc }) => ({
    register: Post('/backers')
      .body(RegisterBackerBody)
      .handle(async ({ body, res }) => {
        res.json(await svc.register(body));
      }),

    get: Get('/backers/:backer')
      .types({ Backer })
      .handle(async ({ params, res }) => {
        const backer = await svc.get(params.backer);
        if (!backer) return res.status(404).json({ error: 'Not found' });
        res.json(backer);
      }),
  }),
});
