import { createContribution } from '@justscale/core';
import { ModelRepository, Reference } from '@justscale/core/models';
import { AbstractPrincipalProvider, Everyone } from '@justscale/permission';
import type { Principal } from '@justscale/permission';
import type { User } from '@justscale/auth';
import { Creator, Backer } from '../domain/index.js';

/**
 * Principal resolvers — one per source. Each is an independent service that
 * contributes some principals; the framework's default aggregator on
 * `AbstractPrincipalProvider` flat-maps them together.
 *
 * Add them to the app with `.add(EveryoneResolver).add(CreatorResolver)
 * .add(BackerResolver)` — order doesn't affect correctness, only which
 * permission wins in ties when multiple declarations match.
 */

/** Emits an `Everyone` principal for every request so `permit(Everyone).always()` matches anyone. */
export const EveryoneResolver = createContribution(AbstractPrincipalProvider, {
  inject: {},
  factory: () => ({
    async resolve(_ctx): Promise<Principal[]> {
      return [{ type: Everyone, ref: new Reference<Everyone>('everyone') }];
    },
  }),
});

/** Looks up the authenticated user in the Creator table by email. */
export const CreatorResolver = createContribution(AbstractPrincipalProvider, {
  inject: { creators: ModelRepository.of(Creator) },
  factory: ({ creators }) => ({
    async resolve(ctx: { user?: InstanceType<typeof User> }): Promise<Principal[]> {
      if (!ctx.user) return [];
      const creator = await creators.findOne(Creator.fields.email.eq(ctx.user.email));
      return creator
        ? [{ type: Creator, ref: Creator.ref(creator as any) }]
        : [];
    },
  }),
});

/** Looks up the authenticated user in the Backer table by email. */
export const BackerResolver = createContribution(AbstractPrincipalProvider, {
  inject: { backers: ModelRepository.of(Backer) },
  factory: ({ backers }) => ({
    async resolve(ctx: { user?: InstanceType<typeof User> }): Promise<Principal[]> {
      if (!ctx.user) return [];
      const backer = await backers.findOne(Backer.fields.email.eq(ctx.user.email));
      return backer
        ? [{ type: Backer, ref: Backer.ref(backer as any) }]
        : [];
    },
  }),
});
