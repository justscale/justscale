/**
 * Standalone controller used by the "adds a new controller" e2e test.
 *
 * Pre-staged in the fixture but NOT added in `app.ts` on boot — the
 * test edits `app.ts` to include `.add(AdminController)` and expects
 * HMR to wire it into the live app (routes answer, counter survives).
 * Keeping the file stable avoids triggering module-reload side effects
 * during the test; only `app.ts` changes.
 */

import { createController } from '@justscale/core';
import { Get } from '@justscale/http/builder';
import { GreetingService } from './greeting.service.js';

export const AdminController = createController({
  inject: { greet: GreetingService },
  routes: ({ greet }) => ({
    ping: Get('/admin/ping').handle(({ res }) => {
      res.json({ ok: true, counter: greet.snapshot().counter });
    }),
  }),
});
