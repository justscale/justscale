/**
 * Paired with CounterService for the "adds a new service + controller"
 * e2e test. Injects CounterService so the test can verify HMR wires up
 * DI when both are freshly .add()'d.
 */

import { createController } from '@justscale/core';
import { Get } from '@justscale/http/builder';
import { CounterService } from './counter.service.js';

export const CounterController = createController({
  inject: { counter: CounterService },
  routes: ({ counter }) => ({
    bumpCounter: Get('/counter/bump').handle(({ res }) => {
      res.json({ value: counter.bump() });
    }),
    readCounter: Get('/counter').handle(({ res }) => {
      res.json({ value: counter.read() });
    }),
  }),
});
