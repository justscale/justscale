import { createController } from '@justscale/core';
import { Get } from '@justscale/http/builder';
import { GreetingService } from './greeting.service.js';
import { SubScopedService } from './sub.service.js';

export const SubController = createController({
  inject: { greet: GreetingService, sub: SubScopedService },
  routes: ({ greet, sub }) => ({
    ping: Get('/sub/ping').handle(({ res }) => {
      res.json({ ok: true, via: greet.greet('sub'), scoped: sub.speak() });
    }),
  }),
});
