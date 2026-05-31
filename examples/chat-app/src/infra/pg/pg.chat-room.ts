import { createPgModel, createPgRepository } from '@justscale/postgres';
import { ChatRoom } from '../../domains/chat/chat-room.model.js';

export const PgChatRoom = createPgModel(ChatRoom, { table: 'chat_rooms' });
export const PgChatRoomRepository = createPgRepository(PgChatRoom);
