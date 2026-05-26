/**
 * Observation point for the service-to-service DI test. Depends on
 * ParentService (which depends on ChildService) — if any link in that
 * chain fails to resolve post-HMR, this route 500s and the test
 * fails.
 */

import { createController } from '@justscale/core';
import { Get } from '@justscale/http/builder';
import { ParentService } from './parent.service.js';

export const LoudController = createController({
  inject: { parent: ParentService },
  routes: ({ parent }) => ({
    loud: Get('/loud/:name').handle(({ params, res }) => {
      res.json({ message: parent.greetLoud(params.name) });
    }),
  }),
});
