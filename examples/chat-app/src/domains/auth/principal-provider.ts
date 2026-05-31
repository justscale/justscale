import { createContribution } from '@justscale/core';
import { AbstractPrincipalProvider, type Principal } from '@justscale/permission';
import { User } from '@justscale/auth';

/**
 * Maps the authenticated ctx.user (set by @justscale/auth's middleware)
 * onto the permission system as a User principal. Chat has a single
 * principal type — User — because moderation flows through HTTP and
 * the CLI runs as operator, outside the guard stack.
 */
export const UserPrincipalResolver = createContribution(AbstractPrincipalProvider, {
  inject: {},
  factory: () => ({
    async resolve(ctx: { user?: InstanceType<typeof User> }): Promise<Principal[]> {
      if (!ctx.user) return [];
      return [{ type: User, ref: User.ref(ctx.user) }];
    },
  }),
});
