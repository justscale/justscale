/**
 * Shared signal catalogue for the pg e2e tests.
 *
 * Intentionally NOT a `.process.ts` file - just signal definitions. Any
 * app instance that adds this service can emit the signals; processes
 * registered with the same signal names receive them.
 */

import { defineSignals } from '@justscale/core/process';
import { createChannels } from '@justscale/core';

export class E2eSignals extends defineSignals(signal => ({
  go:       signal('/e2e/:id/go').data<{ note?: string }>(),
  alt:      signal('/e2e/:id/alt').data<{ note?: string }>(),
  publish:  signal('/e2e/:id/publish').data<{ value: number }>(),
})) {}

export const BroadcastChannels = createChannels<{ value: number; from: string }>({ prefix: 'e2e-broadcast:' });
