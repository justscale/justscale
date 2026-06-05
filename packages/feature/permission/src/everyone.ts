/**
 * Marker class for unauthenticated viewers.
 *
 * Use as a principal type so that `permit(Everyone).always()` matches
 * any caller - including requests without any authenticated principal.
 *
 * Not a persisted model. Auto-contributed by EveryoneProvider for every
 * request, so it's always available as a candidate principal.
 *
 * @example
 * ```typescript
 * permissions: () => ({
 *   view: permit(Everyone).always(),        // anyone can view
 *   edit: permit(User).when(owner),          // only owner can edit
 * })
 * ```
 */
export class Everyone {
  declare readonly _everyone: true;

  /** Stable singleton ref used as the principal ref for Every request. */
  static readonly ref = { identifier: '__everyone__' } as import('@justscale/core/models').Reference<Everyone>;
}

import { createContribution } from '@justscale/core';
import { AbstractPrincipalProvider } from './services/principal-provider.js';
import type { Principal } from './types.js';

/**
 * EveryoneProvider - contributes an Everyone principal for every request.
 * Registered automatically by the permission system so that
 * `permit(Everyone).always()` works without any app-level wiring.
 */
export const EveryoneProvider = createContribution(AbstractPrincipalProvider, {
  inject: {},
  factory: () => ({
    resolve(): Principal[] {
      return [{ type: Everyone, ref: Everyone.ref as any }];
    },
  }),
});
