/**
 * Chat-app entrypoint.
 *
 * Platform features (Postgres, auth, permission) + storage bindings
 * for every model + the chat domain feature (service, controllers,
 * processes). Side-effect imports for @justscale/websocket and /sse
 * register those route factories with the HTTP server on module load.
 */

import { defineApp } from '@justscale/core';
import JustScale, { bindRepository, bindService } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import '@justscale/postgres/virtual/migrations';
import '@justscale/sse';
import '@justscale/websocket';
import {
  AbstractEmailSender,
  AuthEndpointsFeature,
  AuthFeature,
  ConsoleEmailSender,
  Session,
  User,
} from '@justscale/auth';
import { PermissionFeature, PermissionGrant } from '@justscale/permission';
import {
  PostgresFeature,
  PostgresChannelFeature,
  PostgresLockFeature,
  PostgresProcessFeature,
  PostgresMigrationFeature,
} from '@justscale/postgres';
import type { AppEnv } from './env-contract.js';
import { UserPrincipalResolver } from './domains/auth/principal-provider.js';
import { ChatRoom } from './domains/chat/chat-room.model.js';
import { Membership } from './domains/chat/membership.model.js';
import { Message } from './domains/chat/message.model.js';
import { ChatFeature } from './domains/chat/chat.feature.js';
import { PgUserRepository } from './infra/pg/pg.user.js';
import { PgSessionRepository } from './infra/pg/pg.session.js';
import { PgPermissionGrantRepository } from './infra/pg/pg.permission-grant.js';
import { PgChatRoomRepository } from './infra/pg/pg.chat-room.js';
import { PgMembershipRepository } from './infra/pg/pg.membership.js';
import { PgMessageRepository } from './infra/pg/pg.message.js';

export default defineApp(import.meta, (env: AppEnv) =>
  // `as any` keeps the accumulated builder type from leaking internal,
  // non-exported types (e.g. the Postgres channel backend) into the
  // declaration-emitted default export. Same pattern as the other examples.
  (JustScale() as any)
    .add(env)
    .add(PostgresFeature)
    .add(PostgresChannelFeature)
    .add(PostgresLockFeature)
    .add(PostgresProcessFeature)
    .add(PostgresMigrationFeature)
    .add(bindRepository(ModelRepository.of(User),            PgUserRepository))
    .add(bindRepository(ModelRepository.of(Session),         PgSessionRepository))
    .add(bindRepository(ModelRepository.of(PermissionGrant), PgPermissionGrantRepository))
    .add(bindRepository(ModelRepository.of(ChatRoom),        PgChatRoomRepository))
    .add(bindRepository(ModelRepository.of(Membership),      PgMembershipRepository))
    .add(bindRepository(ModelRepository.of(Message),         PgMessageRepository))
    .add(bindService(AbstractEmailSender, ConsoleEmailSender))
    .add(AuthFeature)
    .add(AuthEndpointsFeature)
    .add(UserPrincipalResolver)
    .add(PermissionFeature)
    .add(ChatFeature),
);
