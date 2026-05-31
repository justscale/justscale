/**
 * Chat service tests.
 *
 * Single-instance smoke: verifies the service writes the right rows and
 * fires the right signals, independent of whether the room process is
 * actually running. InMemory repos + InMemoryProcessFeature means
 * signals dispatch synchronously within the same app instance.
 *
 * The multi-instance story is a separate test (TODO) that needs docker
 * postgres because pglite-socket doesn't forward LISTEN/NOTIFY.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import JustScale from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { defaultHttpConfig } from '@justscale/http/testing';
import { UserService } from '@justscale/auth';
import { AuthTestBundle } from '@justscale/auth/testing';

import { ChatRoom } from '../src/domains/chat/chat-room.model.js';
import { Membership } from '../src/domains/chat/membership.model.js';
import { Message } from '../src/domains/chat/message.model.js';
import {
  ChatService,
  AlreadyMemberError,
  NotAMemberError,
  NotAuthorizedError,
  RoomNameTakenError,
} from '../src/domains/chat/chat.service.js';
import { ChatTestBundle } from '../src/domains/chat/chat.test-bundle.js';

describe('ChatService', async () => {
  const built = JustScale()
    .add(defaultHttpConfig)
    .add(AuthTestBundle())
    .add(ChatTestBundle())
    .build();

  const app = built.compile();
  await app.ready;

  const chat         = await app.container.resolve(ChatService);
  const users        = await app.container.resolve(UserService);
  const rooms        = await app.container.resolve(ModelRepository.of(ChatRoom));
  const memberships  = await app.container.resolve(ModelRepository.of(Membership));
  const messages     = await app.container.resolve(ModelRepository.of(Message));

  const alice   = await users.register('alice@example.com',   'hunter2', 'Alice');
  const bob     = await users.register('bob@example.com',     'hunter2', 'Bob');
  const charlie = await users.register('charlie@example.com', 'hunter2', 'Charlie');

  after(async () => { await built.stop(); });

  it('creates a room with the creator as owner', async () => {
    const room = await chat.createRoom(alice, 'general', 'public');
    assert.strictEqual(room.name, 'general');
    assert.strictEqual(room.visibility, 'public');

    const aliceMs = await chat.membershipOf(room, alice);
    assert.ok(aliceMs, 'alice should have a membership');
    assert.strictEqual(aliceMs!.role, 'owner');
  });

  it('rejects duplicate room names', async () => {
    await assert.rejects(
      () => chat.createRoom(bob, 'general', 'public'),
      RoomNameTakenError,
    );
  });

  it('bob joins general as a member', async () => {
    const room = await rooms.findOne(ChatRoom.fields.name.eq('general'));
    assert.ok(room);
    const ms = await chat.join(room!, bob);
    assert.strictEqual(ms.role, 'member');
  });

  it('alice promotes bob to moderator', async () => {
    const room = await rooms.findOne(ChatRoom.fields.name.eq('general'));
    const bobMs = await chat.membershipOf(room!, bob);
    using locked = await memberships.lock(bobMs!);
    assert.ok(locked);
    await chat.promote(locked!, alice, 'moderator');
    const reloaded = await chat.membershipOf(room!, bob);
    assert.strictEqual(reloaded!.role, 'moderator');
  });

  it('rejects duplicate joins', async () => {
    const room = await rooms.findOne(ChatRoom.fields.name.eq('general'));
    await assert.rejects(
      () => chat.join(room!, bob),
      AlreadyMemberError,
    );
  });

  it('rejects posts from non-members', async () => {
    const room = await rooms.findOne(ChatRoom.fields.name.eq('general'));
    await assert.rejects(
      () => chat.post(room!, charlie, 'hi'),
      NotAMemberError,
    );
  });

  it('allows members to post (service-level; process writes the row)', async () => {
    // The service fires messagePosted but does NOT insert Message — the
    // room process does. For single-instance in-memory tests the process
    // isn't running, so no row lands. Verify the service itself doesn't
    // throw for a valid post.
    const room = await rooms.findOne(ChatRoom.fields.name.eq('general'));
    await chat.post(room!, alice, 'hello world');
    // No assertion on Message — that's the room process's job (separate test).
    const count = await messages.find({});
    assert.strictEqual(count.length, 0, 'service does not directly insert Message');
  });

  it('charlie cannot kick bob — not a moderator', async () => {
    const room = await rooms.findOne(ChatRoom.fields.name.eq('general'));
    const bobMs = await chat.membershipOf(room!, bob);
    using locked = await memberships.lock(bobMs!);
    await assert.rejects(
      () => chat.kick(locked!, charlie),
      NotAuthorizedError,
    );
  });

  it('alice bans bob', async () => {
    const room = await rooms.findOne(ChatRoom.fields.name.eq('general'));
    const bobMs = await chat.membershipOf(room!, bob);
    using locked = await memberships.lock(bobMs!);
    const until = new Date(Date.now() + 60_000);
    const updated = await chat.ban(locked!, alice, until);
    assert.strictEqual(updated.bannedUntil?.getTime(), until.getTime());
  });

  it('alice unbans bob', async () => {
    const room = await rooms.findOne(ChatRoom.fields.name.eq('general'));
    const bobMs = await chat.membershipOf(room!, bob);
    using locked = await memberships.lock(bobMs!);
    const updated = await chat.unban(locked!, alice);
    assert.strictEqual(updated.bannedUntil, undefined);
  });

  it('list rooms returns created rooms', async () => {
    const list = await chat.listRooms();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'general');
  });
});
