# @justscale-examples/chat-app

An IRC-like chat room server whose *actual selling point* is this:

> Run it once. Run it sixteen times behind a load balancer. Same code, same
> behaviour. Every room stays consistent, every message reaches every
> subscriber, bans travel, SSE spectators see the same things WS members
> see — and you didn't write a single line of cross-instance coordination.

That's because of durable processes (one logical room = one process that
an advisory lock pins to a single instance) and Postgres LISTEN/NOTIFY
(every instance sees every broadcast). The transport — SSE for
read-only spectators, WebSocket for authenticated members — is a
detail; the room process is the truth.

## Architecture at a glance

```
ChatRoom  ── durable process /chatroom/:room  ──── room.broadcast (Postgres channel)
                    │                              │
                    ▼                              ▼
                    Membership (table)             SSE  ── /rooms/:room/spectate
                    Message    (table)             WS   ── /rooms/:room/ws ──► chatMember subprocess
                                                                                 │
                                                                                 ▼
                                                                                 private signals
                                                                                 (kicked, banned, DM)
```

Pieces:

- `src/domains/chat/chat-room.model.ts` — `ChatRoom` entity + `ChatRoomBroadcast` stream field
- `src/domains/chat/membership.model.ts` — role + mute/ban state, durable source of truth
- `src/domains/chat/message.model.ts` — append-only history
- `src/domains/chat/chat.signals.ts` — every signal the domain emits
- `src/domains/chat/chat.service.ts` — business logic; membership-gated permissions; throws typed errors
- `src/domains/chat/chat-room.process.ts` — the room process (70 lines of handler logic)
- `src/domains/chat/member.process.ts` — per-member subprocess (public broadcast + private signals merged)
- `src/controllers/chat.controller.ts` — REST for rooms, membership, moderation
- `src/controllers/chat-sse.controller.ts` — public read-only `/spectate`
- `src/controllers/chat-ws.controller.ts` — authenticated member socket

## Commands

```bash
pnpm install
just migrate          # generate + apply schema (needs local docker postgres)
just dev              # boot on :6242
just room create <name> <ownerEmail>
just room list
just room show <name>
just user add <email> # interactive password prompt
```

## Single-instance smoke

```bash
docker compose up -d              # start postgres
just migrate make init            # generate initial migration (only if migrations/ is empty)
just migrate run                  # apply it
PGPORT=5433 just dev              # boot on http://localhost:6242
```

- `just user add alice@example.com` — interactive password prompt
- `just room create general alice@example.com`
- `curl -N http://localhost:6242/rooms/general/spectate` — SSE spectator stream
- Log in via HTTP to get a session token, then connect `ws://localhost:6242/rooms/general/ws?token=<token>` and send `{"type":"post","text":"hi"}`

## Multi-instance — the headline

Run the same binary on three ports against one Postgres:

```bash
PORT=6242 PGPORT=5433 just dev     # terminal A
PORT=6243 PGPORT=5433 just dev     # terminal B
PORT=6244 PGPORT=5433 just dev     # terminal C
```

Expected behaviour:

- Spectator curls any of A/B/C and sees every event from every other.
- `POST :6243/rooms/general/members/<user>/ban {"minutes":5}` from B — the
  affected user's WS on A receives `you_were_banned` within milliseconds.
- `kill <A pid>` (the instance holding the room process advisory lock) —
  within ~1s instance B or C takes over. Connected WS clients on B and
  C stay up. A new WS connect to A would bounce to whichever instance
  wins the lock race.
- Three spectators on three different instances all see messages in
  the same order.

There is no sticky session. There is no message bus to configure. There
is no inter-service RPC. Signals route through Postgres, broadcasts
route through LISTEN/NOTIFY, advisory locks pin processes to single
instances. That's the whole story.

## What's in v1 / what's not

**In:**
- Rooms (public / private), membership, role (owner / moderator / member)
- Moderation: kick, ban with `bannedUntil`, unban, change topic
- Posts (WS) + DMs (WS) + spectate (SSE) + history (HTTP)
- Durable `Message` log, append-only
- CLI: `room create / list / show / delete / promote`

**Not yet:**
- **Auto-unban timer** — ban lifts only via explicit `POST /unban`. The
  clean way to add this is a one-shot `banTimer` subprocess that does
  `delay.seconds(r, durationSeconds)` then emits `memberUnbanned`; this
  works because process handlers can't read the wall clock (replay
  safety), so the timer duration has to arrive as a signal payload
  rather than be computed from `until - now` inline. Filed as TODO in
  `member.process.ts`.
- Typing indicators, message edit/delete, reactions, threads
- File uploads
- Cross-Postgres-cluster federation (different problem; not a non-goal
  inside one cluster — cross-instance *is* the demo)

## Tests

```bash
pnpm test
```

Tests share `src/test.ts` which swaps pg for pglite and the channel
backend for `MemoryChannelBackend` (pglite-socket doesn't forward
LISTEN/NOTIFY). Single-instance tests cover:

- Service behaviour (`test/chat-service.test.ts`)
- Room process signal routing (`test/room-process.test.ts`)

The automated multi-instance test is the intended next step — it needs
real docker Postgres (not pglite) because the whole point is proving
LISTEN/NOTIFY + advisory locks bridge instances. The manual walkthrough
above is the current proof of that story; wrapping it in a test file
is on the punch-list.
