import { Logger, createFeatureBuilder } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { AbstractProcessExecutor } from '@justscale/core/process';
import { User } from '@justscale/auth';
import { ChatRoom } from './chat-room.model.js';
import { Membership } from './membership.model.js';
import { Message } from './message.model.js';
import { ChatSignals } from './chat.signals.js';
import { ChatService } from './chat.service.js';
import { ChatController } from '../../controllers/chat.controller.js';
import { ChatSseController } from '../../controllers/chat-sse.controller.js';
import { ChatWsController } from '../../controllers/chat-ws.controller.js';
import { ChatCliController } from './chat.cli.js';

export const ChatFeature = createFeatureBuilder()
  .name('chat')
  .requires(ModelRepository.of(User))
  .requires(ModelRepository.of(ChatRoom))
  .requires(ModelRepository.of(Membership))
  .requires(ModelRepository.of(Message))
  .requires(AbstractProcessExecutor)
  .requires(Logger)
  .provides(b =>
    b
      .add(ChatSignals)
      .add(ChatService)
      .add(ChatController)
      .add(ChatSseController)
      .add(ChatWsController)
      .add(ChatCliController),
  );
