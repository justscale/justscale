import { createController } from '@justscale/core';
import { ModelRepository, q } from '@justscale/core/models';
import { Cli } from '@justscale/core/cli';
import { z } from 'zod';
import { User } from '@justscale/auth';
import { ChatRoom } from './chat-room.model.js';
import { Membership } from './membership.model.js';
import { Message } from './message.model.js';
import { ChatService } from './chat.service.js';

export const ChatCliController = createController({
  inject: {
    chat:        ChatService,
    rooms:       ModelRepository.of(ChatRoom),
    memberships: ModelRepository.of(Membership),
    messages:    ModelRepository.of(Message),
    users:       ModelRepository.of(User),
  },
  routes: ({ chat, rooms, memberships, messages, users }) => ({
    roomList: Cli('room list').handle(async ({ io }) => {
      const all = await rooms.find({});
      if (all.length === 0) { io.log('No rooms.'); return; }
      io.log(`  ${'name'.padEnd(24)} ${'visibility'.padEnd(10)} ${'members'.padStart(8)} ${'messages'.padStart(10)}`);
      for (const r of all) {
        const memberCount = (await memberships.find({ where: Membership.fields.room.eq(r) })).length;
        const messageCount = (await messages.find({ where: Message.fields.room.eq(r) })).length;
        io.log(`  ${r.name.padEnd(24)} ${r.visibility.padEnd(10)} ${String(memberCount).padStart(8)} ${String(messageCount).padStart(10)}`);
      }
    }),

    roomCreate: Cli('room create')
      .input(z.object({
        name: z.string().describe('Room name (unique)'),
        ownerEmail: z.string().email().describe('Email of the owning user'),
        visibility: z.enum(['public', 'private']).default('public'),
      }))
      .handle(async ({ args, io }) => {
        const owner = await users.findOne(User.fields.email.eq(args.ownerEmail));
        if (!owner) { io.error(`No user: ${args.ownerEmail}`); return; }
        const room = await chat.createRoom(owner, args.name, args.visibility);
        io.log(`Created room '${room.name}' (${args.visibility})`);
      }),

    roomShow: Cli('room show')
      .input(z.object({ name: z.string() }))
      .handle(async ({ args, io }) => {
        const room = await rooms.findOne(ChatRoom.fields.name.eq(args.name));
        if (!room) { io.error(`No room: ${args.name}`); return; }
        io.log(`Name:       ${room.name}`);
        io.log(`Topic:      ${room.topic ?? '(none)'}`);
        io.log(`Visibility: ${room.visibility}`);
        const ms = await memberships.find({ where: Membership.fields.room.eq(room) });
        io.log(`\nMembers (${ms.length}):`);
        for (const m of ms) {
          const u = await users.get(m.user);
          const tag = m.bannedUntil ? ' [BANNED]' : m.mutedUntil ? ' [MUTED]' : '';
          io.log(`  ${(u?.email ?? '(missing)').padEnd(32)} ${m.role.padEnd(10)}${tag}`);
        }
      }),

    roomDelete: Cli('room delete')
      .input(z.object({ name: z.string() }))
      .handle(async ({ args, io }) => {
        const room = await rooms.findOne(ChatRoom.fields.name.eq(args.name));
        if (!room) { io.error(`No room: ${args.name}`); return; }
        using locked = await rooms.lock(room);
        if (!locked) { io.error('Room busy'); return; }
        await messages.deleteWhere(Message.fields.room.eq(room));
        await memberships.deleteWhere(Membership.fields.room.eq(room));
        await rooms.delete(locked);
        io.log(`Deleted room '${args.name}' + all memberships + all messages`);
      }),

    membershipPromote: Cli('room promote')
      .input(z.object({
        room: z.string().describe('Room name'),
        email: z.string().email().describe('User email'),
        role: z.enum(['owner', 'moderator', 'member']),
      }))
      .handle(async ({ args, io }) => {
        const room = await rooms.findOne(ChatRoom.fields.name.eq(args.room));
        if (!room) { io.error(`No room: ${args.room}`); return; }
        const user = await users.findOne(User.fields.email.eq(args.email));
        if (!user) { io.error(`No user: ${args.email}`); return; }
        const m = await memberships.findOne(
          q.and(Membership.fields.room.eq(room), Membership.fields.user.eq(user)),
        );
        if (!m) { io.error(`${args.email} is not a member of ${args.room}`); return; }
        using locked = await memberships.lock(m);
        if (!locked) { io.error('Membership busy'); return; }
        await memberships.update(locked, { role: args.role });
        io.log(`Set ${args.email} → ${args.role} in ${args.room}`);
      }),
  }),
});
