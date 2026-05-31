/**
 * AbstractPrincipalProvider - resolves the current request context into a list of principals.
 *
 * This is a **contribution** token: multiple small services can each contribute
 * some principals, and the framework-provided default aggregator flat-maps
 * their results. Use `createContribution(AbstractPrincipalProvider, {...})`
 * to add a resolver.
 *
 * Apps needing a single monolithic provider can still bind one via
 * `bindService(AbstractPrincipalProvider, MyProvider)` - that replaces the
 * default aggregator.
 *
 * @example
 * ```typescript
 * // Multiple small resolvers - each contributes some principals.
 * export const AuthResolver = createContribution(AbstractPrincipalProvider, {
 *   inject: {},
 *   factory: () => ({
 *     async resolve(ctx) {
 *       if (!ctx.user) return [];
 *       return [{ type: AppUser, ref: AppUser.ref(ctx.user) }];
 *     },
 *   }),
 * });
 *
 * export const SellerResolver = createContribution(AbstractPrincipalProvider, {
 *   inject: { sellers: SellerRepository },
 *   factory: ({ sellers }) => ({
 *     async resolve(ctx) {
 *       if (!ctx.user) return [];
 *       const seller = await sellers.findByUser(ctx.user);
 *       return seller ? [{ type: Seller, ref: Seller.ref(seller) }] : [];
 *     },
 *   }),
 * });
 * ```
 */

import { defineContribution } from '@justscale/core';
import type { Principal } from '../types.js';

export interface PrincipalProvider {
  resolve(ctx: any): Principal[] | Promise<Principal[]>;
}

export abstract class AbstractPrincipalProvider extends defineContribution<PrincipalProvider>(
  'AbstractPrincipalProvider',
  {
    aggregate: (contributions) => ({
      async resolve(ctx: any): Promise<Principal[]> {
        const lists = await Promise.all(contributions.map((c) => c.resolve(ctx)));
        return lists.flat();
      },
    }),
  },
) {}
