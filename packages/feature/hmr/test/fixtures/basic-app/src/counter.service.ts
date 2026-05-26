/**
 * Pre-staged for the "adds a new service + controller via .add()" e2e
 * test. Not wired on boot — app.ts imports it with a `void` to keep
 * esbuild from tree-shaking the module, then the test edits app.ts to
 * `.add(CounterService).add(CounterController)` in one go. Exercises
 * DI from a brand-new controller to a brand-new service — the service
 * is registered by HMR's rebuild path, then resolved when the
 * controller is resolved against the live container.
 */

import { defineService } from '@justscale/core';

export class CounterService extends defineService({
  inject: {},
  factory: () => {
    let n = 0;
    return {
      bump: () => ++n,
      read: () => n,
    };
  },
}) {}
