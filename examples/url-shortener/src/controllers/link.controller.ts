import { createController } from '@justscale/core';
import { Get, Post } from '@justscale/http';
import { z } from 'zod';
import { LinkService } from '../domains/link/link.service.js';

// The controller is the only place that knows about HTTP. It injects the
// service and maps requests onto its methods - nothing more.
export const LinkController = createController('/', {
  inject: { links: LinkService },
  routes: ({ links }) => ({
    shorten: Post('/shorten')
      .body(z.object({ url: z.string().url() }))
      .handle(async ({ body, res }) => {
        const link = await links.shorten(body.url);
        res.json({ slug: link.slug, short: `/${link.slug}` });
      }),

    resolve: Get('/:slug').handle(async ({ params, res }) => {
      const link = await links.resolve(params.slug);
      if (!link) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({ target: link.target, hits: link.hits });
    }),
  }),
});
