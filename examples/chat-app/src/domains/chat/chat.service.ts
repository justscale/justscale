import { Logger, defineService } from '@justscale/core';
import {
  ModelRepository,
  q,
  type Locked,
  type Persistent,
  type Ref,
} from '@justscale/core/models';
import { User } from '@justscale/auth';
import { ChatRoom } from './chat-room.model.js';
import { Membership, type MembershipRole } from './membership.model.js';
import { Message } from './message.model.js';
import { ChatSignals } from './chat.signals.js';
import { chatRoom } from './chat-room.process.js';

export class NotAMemberError extends Error {
  constructor() { super('Not a member of this room'); this.name = 'NotAMemberError'; }
}
export class BannedError extends Error {
  constructor(public until: Date) { super(`Banned until ${until.toISOString()}`); this.name = 'BannedError'; }
}
export class MutedError extends Error {
  constructor(public until: Date) { super(`Muted until ${until.toISOString()}`); this.name = 'MutedError'; }
}
export class NotAuthorizedError extends Error {
  constructor(action: string) { super(`Not authorized to ${action}`); this.name = 'NotAuthorizedError'; }
}
export class RoomNameTakenError extends Error {
  constructor(name: string) { super(`Room name already taken: ${name}`); this.name = 'RoomNameTakenError'; }
}
export class AlreadyMemberError extends Error {
  constructor() { super('Already a member of this room'); this.name = 'AlreadyMemberError'; }
}

function isActive(m: Persistent<Membership>, now = Date.now()): boolean {
  return !(m.bannedUntil && m.bannedUntil.getTime() > now);
}
function canPost(m: Persistent<Membership>, now = Date.now()): boolean {
  return isActive(m, now) && !(m.mutedUntil && m.mutedUntil.getTime() > now);
}
function canModerate(m: Persistent<Membership>): boolean {
  return m.role === 'owner' || m.role === 'moderator';
}

export class ChatService extends defineService({
  inject: {
    rooms:       ModelRepository.of(ChatRoom),
    memberships: ModelRepository.of(Membership),
    messages:    ModelRepository.of(Message),
    signals:     ChatSignals,
    logger:      Logger,
  },
  factory: ({ rooms, memberships, messages, signals, logger }) => {
    const roomId = (room: Ref<ChatRoom>) => ChatRoom.ref(room).identifier;
    const userId = (user: Ref<User>)     => User.ref(user).identifier;

    const membershipOf = (room: Ref<ChatRoom>, user: Ref<User>) =>
      memberships.findOne(
        q.and(Membership.fields.room.eq(room), Membership.fields.user.eq(user)),
      );

    return {
      async createRoom(
        creator: Ref<User>,
        name: string,
        visibility: 'public' | 'private' = 'public',
      ): Promise<Persistent<ChatRoom>> {
        const existing = await rooms.findOne(ChatRoom.fields.name.eq(name));
        if (existing) throw new RoomNameTakenError(name);
        const room = await rooms.insert({ name, visibility, createdBy: creator });
        await memberships.insert({ room, user: creator, role: 'owner', joinedAt: new Date() });
        logger.info('Room created', { name, visibility });
        return room;
      },

      async listRooms(): Promise<Persistent<ChatRoom>[]> {
        return rooms.find({});
      },

      /**
       * Idempotently start the room process (by advisory lock, only one
       * instance across the cluster actually runs it; all others no-op).
       */
      async ensureProcess(room: Ref<ChatRoom>) {
        return chatRoom([ChatRoom.ref(room).identifier]);
      },

      membershipOf,

      async historyOf(room: Ref<ChatRoom>, limit = 100): Promise<Persistent<Message>[]> {
        return messages.find({
          where: Message.fields.room.eq(room),
          orderBy: { postedAt: 'desc' },
          limit,
        });
      },

      async join(room: Ref<ChatRoom>, user: Ref<User>): Promise<Persistent<Membership>> {
        const existing = await membershipOf(room, user);
        if (existing) {
          if (!isActive(existing)) throw new BannedError(existing.bannedUntil!);
          throw new AlreadyMemberError();
        }
        const membership = await memberships.insert({ room, user, role: 'member', joinedAt: new Date() });
        await signals.memberJoined({ room: roomId(room), user: userId(user), role: 'member' });
        return membership;
      },

      async leave(membership: Locked<Membership>): Promise<void> {
        await signals.memberLeaving({ room: roomId(membership.room), user: userId(membership.user) });
        await memberships.delete(membership);
      },

      /**
       * Validates membership + mute/ban state, then fires messagePosted.
       * The room process writes the Message row and publishes the
       * broadcast — all message ordering funnels through the process
       * advisory lock, regardless of how many instances serve WS.
       */
      async post(room: Ref<ChatRoom>, author: Ref<User>, text: string): Promise<void> {
        const m = await membershipOf(room, author);
        if (!m) throw new NotAMemberError();
        if (m.bannedUntil && m.bannedUntil.getTime() > Date.now()) throw new BannedError(m.bannedUntil);
        if (m.mutedUntil  && m.mutedUntil.getTime()  > Date.now()) throw new MutedError(m.mutedUntil);
        if (!text.trim()) return;
        await signals.messagePosted({
          room: roomId(room),
          author: userId(author),
          text,
          at: new Date().toISOString(),
        });
      },

      async sendDm(
        room: Ref<ChatRoom>,
        from: Ref<User>,
        to: Ref<User>,
        text: string,
      ): Promise<void> {
        const fromM = await membershipOf(room, from);
        if (!fromM) throw new NotAMemberError();
        if (!canPost(fromM)) throw new MutedError(fromM.mutedUntil ?? fromM.bannedUntil ?? new Date());
        await signals.dm({ room: roomId(room), user: userId(to), from: userId(from), text });
      },

      async changeTopic(
        room: Ref<ChatRoom>,
        topic: string,
        by: Ref<User>,
      ): Promise<void> {
        const m = await membershipOf(room, by);
        if (!m || !canModerate(m)) throw new NotAuthorizedError('change topic');
        await signals.topicChanged({ room: roomId(room), topic, by: userId(by) });
      },

      async kick(target: Locked<Membership>, by: Ref<User>, reason?: string): Promise<void> {
        const byM = await membershipOf(target.room, by);
        if (!byM || !canModerate(byM)) throw new NotAuthorizedError('kick');
        await signals.memberKicked({
          room: roomId(target.room),
          user: userId(target.user),
          by: userId(by),
          reason,
        });
        await memberships.delete(target);
      },

      async ban(
        target: Locked<Membership>,
        by: Ref<User>,
        until: Date,
      ): Promise<Persistent<Membership>> {
        const byM = await membershipOf(target.room, by);
        if (!byM || !canModerate(byM)) throw new NotAuthorizedError('ban');
        const updated = await memberships.update(target, { bannedUntil: until });
        await signals.memberBanned({
          room: roomId(target.room),
          user: userId(target.user),
          by: userId(by),
          until: until.toISOString(),
        });
        return updated;
      },

      async unban(target: Locked<Membership>, by: Ref<User>): Promise<Persistent<Membership>> {
        const byM = await membershipOf(target.room, by);
        if (!byM || !canModerate(byM)) throw new NotAuthorizedError('unban');
        const updated = await memberships.update(target, { bannedUntil: undefined });
        await signals.memberUnbanned({
          room: roomId(target.room),
          user: userId(target.user),
        });
        return updated;
      },

      async promote(target: Locked<Membership>, by: Ref<User>, role: MembershipRole): Promise<Persistent<Membership>> {
        const byM = await membershipOf(target.room, by);
        if (!byM || byM.role !== 'owner') throw new NotAuthorizedError('promote');
        return memberships.update(target, { role });
      },
    };
  },
}) {}
