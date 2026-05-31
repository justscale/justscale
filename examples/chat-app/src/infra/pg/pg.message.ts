import { createPgModel, createPgRepository } from '@justscale/postgres';
import { Message } from '../../domains/chat/message.model.js';

export const PgMessage = createPgModel(Message, { table: 'messages' });
export const PgMessageRepository = createPgRepository(PgMessage);
