import { randomBytes } from 'node:crypto';
import { defineService } from '@justscale/core';
import {
  ModelRepository,
  q,
  type Locked,
  type Persistent,
  type Ref,
} from '@justscale/core/models';
import { Session } from '../models/session.js';
import { User } from '../models/user.js';

const TOKEN_LENGTH = 32;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface CreateSessionOptions {
  userAgent?: string
  ipAddress?: string
  ttlMs?: number
}

export class SessionService extends defineService({
  inject: {
    sessions: ModelRepository.of(Session),
  },
  factory: ({ sessions }) => ({
    async create(user: Persistent<User>, options: CreateSessionOptions = {}) {
      const token = randomBytes(TOKEN_LENGTH).toString('hex');
      const ttl = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
      const now = new Date();

      return sessions.insert({
        user,
        token,
        userAgent: options.userAgent,
        ipAddress: options.ipAddress,
        expiresAt: new Date(now.getTime() + ttl),
        lastActiveAt: now,
      });
    },

    async findByToken(token: string) {
      const session = await sessions.findOne(Session.fields.token.eq(token));
      if (!session) return null;

      if (session.expiresAt < new Date()) {
        using locked = await sessions.lock(session);
        if (locked) await sessions.delete(locked);
        return null;
      }

      return session;
    },

    async touch(session: Locked<Session>) {
      return sessions.update(session, { lastActiveAt: new Date() });
    },

    async revoke(session: Locked<Session>) {
      return sessions.delete(session);
    },

    async revokeAllForUser(
      user: Ref<User>,
      options: { exceptToken?: string } = {},
    ) {
      if (options.exceptToken) {
        return sessions.deleteWhere(
          q.and(
            Session.fields.user.eq(user),
            Session.fields.token.neq(options.exceptToken),
          ),
        );
      }
      return sessions.deleteWhere(Session.fields.user.eq(user));
    },

    async revokeExpired() {
      return sessions.deleteWhere(Session.fields.expiresAt.lt(new Date()));
    },
  }),
}) {}

export type SessionServiceInstance = ReturnType<typeof SessionService.factory>;
