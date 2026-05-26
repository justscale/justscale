import { createController } from '@justscale/core';
import { Get, Post } from '@justscale/http/builder';
import { GreetingService } from './greeting.service.js';

export const GreetingController = createController({
  inject: { greet: GreetingService },
  routes: ({ greet }) => ({
    hello: Get('/hello/:name').handle(({ params, res }) => {
      res.json({ message: greet.greet(params.name) });
    }),

    bump: Post('/bump').handle(({ res }) => {
      res.json({ counter: greet.bumpCounter() });
    }),

    snapshot: Get('/snapshot').handle(({ res }) => {
      res.json(greet.snapshot());
    }),
  }),
});
