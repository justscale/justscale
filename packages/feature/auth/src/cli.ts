import { createController } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { Cli } from '@justscale/core/cli';
import { z } from 'zod';
import { UserService } from './services/user.service.js';
import { SessionService } from './services/session.service.js';
import { User } from './models/user.js';
import { Session } from './models/session.js';

export const AuthCliController = createController({
  inject: {
    users: UserService,
    sessions: SessionService,
    userRepo: ModelRepository.of(User),
    sessionRepo: ModelRepository.of(Session),
  },
  routes: ({ users, sessions, userRepo, sessionRepo }) => ({
    addUser: Cli('user add')
      .describe('Create a new user account')
      .input(z.object({
        email: z.email().meta({
          description: 'User email address',
          examples: ['alice@example.com'],
        }),
        name: z.string().optional().meta({ description: 'User display name' }),
      }))
      .handle(async (ctx) => {
        const password = await ctx.io.password('Password');
        const user = await users.register(ctx.args.email, password, ctx.args.name);
        ctx.io.log(`User created: ${user.email}`);
      }),

    listUsers: Cli('user list')
      .describe('List all registered users')
      .handle(async (ctx) => {
        const allUsers = await userRepo.find();
        if (allUsers.length === 0) {
          ctx.io.log('No users found.');
          return;
        }
        for (const user of allUsers) {
          ctx.io.log(`  ${user.email}${user.name ? ` (${user.name})` : ''}`);
        }
      }),

    listSessions: Cli('session list')
      .describe('List active sessions')
      .handle(async (ctx) => {
        const allSessions = await sessionRepo.find();
        if (allSessions.length === 0) {
          ctx.io.log('No active sessions.');
          return;
        }
        for (const session of allSessions) {
          ctx.io.log(`  ${session.token.slice(0, 8)}... expires ${session.expiresAt.toISOString()}`);
        }
      }),

    revokeSession: Cli('session revoke')
      .describe('Revoke all sessions for a user')
      .input(z.object({
        email: z.email().meta({
          description: 'User email whose sessions will be revoked',
          examples: ['alice@example.com'],
        }),
      }))
      .handle(async (ctx) => {
        const user = await users.findByEmail(ctx.args.email);
        if (!user) {
          ctx.io.error(`User not found: ${ctx.args.email}`);
          return;
        }
        await sessions.revokeAllForUser(user);
        ctx.io.log(`Sessions revoked for ${ctx.args.email}`);
      }),
  }),
});
