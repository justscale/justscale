/**
 * Module-scoped state that SHOULD survive HMR rebuilds.
 *
 * This file is not expected to be edited during tests. If the process
 * restarted (instead of hot-swapping services), the counter would
 * reset to 0 — which is how tests detect a false-positive "HMR worked".
 */
export const state = {
  counter: 0,
  trail: [] as string[],
};
