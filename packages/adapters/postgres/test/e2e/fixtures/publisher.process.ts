/**
 * Process fixture that publishes to a channel on receiving a signal.
 *
 * Exercises the composition path: process handler -> channel.publish ->
 * pg NOTIFY -> subscriber on another instance.
 */

import { createProcess, race, signal, delay } from '@justscale/core/process';
import { E2eSignals, BroadcastChannels } from './e2e-signals.js';

export const publishThroughChannel = createProcess({
  path: '/e2e-publish/:id',
  inject: {
    signals: E2eSignals,
    channels: BroadcastChannels,
  },

  async handler({ signals, channels }, { id }) {
    const r = race();
    switch (true) {
      case signal(r, signals.publish):
        channels.publish(`pub:${id}`, { value: r.value, from: id });
        return { id, published: r.value };
      case delay.seconds(r, 30):
        return { id, timedOut: true };
    }
  },
});
