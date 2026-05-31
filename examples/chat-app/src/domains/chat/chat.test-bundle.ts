/**
 * Test bundle for chat.
 *
 * Fresh in-memory repos per call so a test file can mount multiple
 * JustScale apps without state leakage. Multi-instance tests share a
 * single set of repos across apps to simulate one-database-many-pods.
 */

import { createFeatureBuilder, bindRepository, Logger } from '@justscale/core';
import { ModelRepository, getModelFields } from '@justscale/core/models';
import { InMemoryRepository } from '@justscale/core/models/in-memory';
import { AbstractProcessExecutor } from '@justscale/core/process';
import { User } from '@justscale/auth';

import { ChatRoom } from './chat-room.model.js';
import { Membership } from './membership.model.js';
import { Message } from './message.model.js';
import { ChatFeature } from './chat.feature.js';

export interface ChatTestBundleOptions {
  roomRepo?: InMemoryRepository<ChatRoom>
  membershipRepo?: InMemoryRepository<Membership>
  messageRepo?: InMemoryRepository<Message>
}

export function ChatTestBundle(options: ChatTestBundleOptions = {}) {
  const roomRepo       = options.roomRepo       ?? new InMemoryRepository<ChatRoom>({ fieldDefs: getModelFields(ChatRoom) });
  const membershipRepo = options.membershipRepo ?? new InMemoryRepository<Membership>({ fieldDefs: getModelFields(Membership) });
  const messageRepo    = options.messageRepo    ?? new InMemoryRepository<Message>({ fieldDefs: getModelFields(Message) });

  return createFeatureBuilder()
    .name('chat-test')
    .requires(AbstractProcessExecutor)
    .requires(Logger)
    .requires(ModelRepository.of(User))
    .provides((b) =>
      b
        .add(bindRepository(ModelRepository.of(ChatRoom),   roomRepo))
        .add(bindRepository(ModelRepository.of(Membership), membershipRepo))
        .add(bindRepository(ModelRepository.of(Message),    messageRepo))
        .add(ChatFeature),
    );
}
