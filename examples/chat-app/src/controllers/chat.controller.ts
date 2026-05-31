import { createController } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { Get, Post, Patch, Delete } from '@justscale/http/builder';
import { User, auth } from '@justscale/auth';
import { permissions } from '@justscale/permission';
import { ChatRoom } from '../domains/chat/chat-room.model.js';
import { Membership } from '../domains/chat/membership.model.js';
import {
  ChatService,
  AlreadyMemberError,
  BannedError,
  MutedError,
  NotAMemberError,
  NotAuthorizedError,
  RoomNameTakenError,
} from '../domains/chat/chat.service.js';
import {
  BanBody,
  ChangeTopicBody,
  CreateRoomBody,
  ErrorResponse,
  HistoryResponse,
  KickBody,
  MembershipResponse,
  OkResponse,
  RoomListResponse,
  RoomResponse,
} from './schemas/chat.js';

/**
 * Translate a service error to an HTTP status + JSON body.
 * Returns true if the error was handled, false if the caller should rethrow.
 */
function sendError(res: any, err: unknown): boolean {
  if (err instanceof NotAMemberError)     { res.status(403).json({ error: err.message }); return true; }
  if (err instanceof BannedError)         { res.status(403).json({ error: err.message }); return true; }
  if (err instanceof MutedError)          { res.status(403).json({ error: err.message }); return true; }
  if (err instanceof NotAuthorizedError)  { res.status(403).json({ error: err.message }); return true; }
  if (err instanceof RoomNameTakenError)  { res.status(409).json({ error: err.message }); return true; }
  if (err instanceof AlreadyMemberError)  { res.status(409).json({ error: err.message }); return true; }
  return false;
}

export const ChatController = createController({
  inject: {
    chat:        ChatService,
    memberships: ModelRepository.of(Membership),
  },
  routes: ({ chat, memberships }) => ({
    list: Get('/rooms')
      .use(auth)
      .returns(200, RoomListResponse)
      .handle(async ({ res }) => {
        const list = await chat.listRooms();
        res.json({ rooms: list });
      }),

    create: Post('/rooms')
      .use(auth)
      .body(CreateRoomBody)
      .returns(201, RoomResponse)
      .returns(409, ErrorResponse)
      .handle(async ({ user, body, res }) => {
        try {
          const room = await chat.createRoom(user, body.name, body.visibility);
          res.status(201).json({ room });
        } catch (err) {
          if (sendError(res, err)) return;
          throw err;
        }
      }),

    get: Get('/rooms/:room')
      .use(auth)
      .use(permissions)
      .types({ room: ChatRoom })
      .guard(ChatRoom.can.view)
      .returns(200, RoomResponse)
      .returns(404, ErrorResponse)
      .handle(async ({ params, res }) => {
        const room = await params.room;
        if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
        res.json({ room });
      }),

    join: Post('/rooms/:room/join')
      .use(auth)
      .use(permissions)
      .types({ room: ChatRoom })
      .guard(ChatRoom.can.view)
      .returns(201, MembershipResponse)
      .returns(404, ErrorResponse)
      .returns(409, ErrorResponse)
      .returns(403, ErrorResponse)
      .handle(async ({ user, params, res }) => {
        const room = await params.room;
        if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
        try {
          const membership = await chat.join(room, user);
          res.status(201).json({ membership });
        } catch (err) {
          if (sendError(res, err)) return;
          throw err;
        }
      }),

    leave: Delete('/rooms/:room/membership')
      .use(auth)
      .types({ room: ChatRoom })
      .returns(200, OkResponse)
      .returns(404, ErrorResponse)
      .returns(409, ErrorResponse)
      .handle(async ({ user, params, res }) => {
        const room = await params.room;
        if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
        const membership = await chat.membershipOf(room, user);
        if (!membership) { res.status(404).json({ error: 'Not a member' }); return; }
        using locked = await memberships.lock(membership);
        if (!locked) { res.status(409).json({ error: 'Membership busy' }); return; }
        await chat.leave(locked);
        res.json({ ok: true as const });
      }),

    changeTopic: Patch('/rooms/:room/topic')
      .use(auth)
      .types({ room: ChatRoom })
      .body(ChangeTopicBody)
      .returns(200, OkResponse)
      .returns(403, ErrorResponse)
      .returns(404, ErrorResponse)
      .handle(async ({ user, params, body, res }) => {
        const room = await params.room;
        if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
        try {
          await chat.changeTopic(room, body.topic, user);
          res.json({ ok: true as const });
        } catch (err) {
          if (sendError(res, err)) return;
          throw err;
        }
      }),

    history: Get('/rooms/:room/history')
      .use(auth)
      .use(permissions)
      .types({ room: ChatRoom })
      .guard(ChatRoom.can.view)
      .returns(200, HistoryResponse)
      .returns(404, ErrorResponse)
      .handle(async ({ params, res }) => {
        const room = await params.room;
        if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
        const messages = await chat.historyOf(room, 100);
        res.json({ messages });
      }),

    kick: Post('/rooms/:room/members/:user/kick')
      .use(auth)
      .types({ room: ChatRoom, user: User })
      .body(KickBody)
      .returns(200, OkResponse)
      .returns(403, ErrorResponse)
      .returns(404, ErrorResponse)
      .returns(409, ErrorResponse)
      .handle(async ({ user, params, body, res }) => {
        const room = await params.room;
        if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
        const target = await chat.membershipOf(room, params.user);
        if (!target) { res.status(404).json({ error: 'Target is not a member' }); return; }
        using locked = await memberships.lock(target);
        if (!locked) { res.status(409).json({ error: 'Membership busy' }); return; }
        try {
          await chat.kick(locked, user, body.reason);
          res.json({ ok: true as const });
        } catch (err) {
          if (sendError(res, err)) return;
          throw err;
        }
      }),

    ban: Post('/rooms/:room/members/:user/ban')
      .use(auth)
      .types({ room: ChatRoom, user: User })
      .body(BanBody)
      .returns(200, MembershipResponse)
      .returns(403, ErrorResponse)
      .returns(404, ErrorResponse)
      .returns(409, ErrorResponse)
      .handle(async ({ user, params, body, res }) => {
        const room = await params.room;
        if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
        const target = await chat.membershipOf(room, params.user);
        if (!target) { res.status(404).json({ error: 'Target is not a member' }); return; }
        using locked = await memberships.lock(target);
        if (!locked) { res.status(409).json({ error: 'Membership busy' }); return; }
        try {
          const until = new Date(Date.now() + body.minutes * 60_000);
          const updated = await chat.ban(locked, user, until);
          res.json({ membership: updated });
        } catch (err) {
          if (sendError(res, err)) return;
          throw err;
        }
      }),

    unban: Post('/rooms/:room/members/:user/unban')
      .use(auth)
      .types({ room: ChatRoom, user: User })
      .returns(200, MembershipResponse)
      .returns(403, ErrorResponse)
      .returns(404, ErrorResponse)
      .returns(409, ErrorResponse)
      .handle(async ({ user, params, res }) => {
        const room = await params.room;
        if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
        const target = await chat.membershipOf(room, params.user);
        if (!target) { res.status(404).json({ error: 'Target is not a member' }); return; }
        using locked = await memberships.lock(target);
        if (!locked) { res.status(409).json({ error: 'Membership busy' }); return; }
        try {
          const updated = await chat.unban(locked, user);
          res.json({ membership: updated });
        } catch (err) {
          if (sendError(res, err)) return;
          throw err;
        }
      }),
  }),
});
