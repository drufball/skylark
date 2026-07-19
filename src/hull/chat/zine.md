# Chat

_chat zine — issue #67_

## tl;dr

Chat is the ship's front door: conversations between the crew — humans and
agents. A chat is a set of **members**, and **membership is visibility**: only
members see a chat, and an added member sees the whole history (no per-message
ACL). Agents are members too; when one needs to speak, the chat orchestrator
drives its backing agent session and posts the reply back as a chat message.

The one idea that shapes everything: **the clean chat transcript and the agent's
full tool-call transcript are two surfaces over one conversation.** Chat shows
only the assistant's _text_; the thinking and tool calls stay in the agent
session (visible in the Agents view). Chat lives in the hull — it's load-bearing
and drives the ship's residents, like the issues board does — with its view in
the rigging.

## Components

- **Chat** — one conversation, a row in `chats`: an optional title and an
  activity clock that orders the sidebar. Named by its members when untitled.
- **Member** — a row in `chat_members`, one per (chat, user). The visibility
  list. For an agent member, `sessionId` points at its backing agent session for
  this chat (created lazily on first reply, kept for continuity).
- **Message** — a row in `chat_messages`: a member's text, ordered by UUIDv7 id.
- **Service logic** (`service.ts`) — pure persistence + the pure response rules
  (`parseMentions`, `targetsForMessage`, `formatTranscript`). Touches only its
  own three tables (plus a read-join onto users for display).
- **Orchestrator** (`orchestrator.ts`) — turns a posted message into agent
  replies: who should answer, drive each one's session, lift the assistant text
  back into the chat. `handleBusNote` is its ship-log subscription (a posted
  message drives the reply); `wake` runs a briefing turn when a notification
  arrives; `reconcile` is startup recovery. Injected runtime, so the decisions
  are unit-tested against PGlite with a fake.
- **turnContext** — the situational header every reply turn opens with: who the
  agent is, which chat this is, and the concrete
  `npm run issue -- new … --body …` command for filing work. Repeated per turn —
  cheap, and it survives session compaction. `inboxTurnContext` is its
  counterpart for a wake turn: it opens instead with "this is your inbox, not a
  chat" and the chat-CLI commands (`list`/`show`/`post`) for finding and
  updating the right conversation.
- **The waker** (`waker.ts`) — the bridge from notifications to a sleeping
  agent: debounces a flurry (10s) into ONE wake per agent (not per chat — the
  waker knows nothing about chat), and drives the orchestrator's `wake` with the
  whole batch briefed. A batch is marked read only AFTER its wake succeeds — a
  failed wake leaves the rows unread to retry. Every batch wakes; routing an
  update to a chat (or not) is the agent's own judgment, made from its bash tool
  via the chat CLI, not the waker's.
- **Chat and inbox sessions boot on the ship default model** (`DEFAULT_MODEL` in
  the agent service — one default everywhere, through the LLM gateway); an
  agent's own model override still wins at boot. The old
  `CHAT_MODEL`/`SKYLARK_CHAT_MODEL` split retired with the gateway move.
- **The live shell** (`orchestrator-live.ts`) — the impure wiring:
  `ensureChatOrchestrator` boots the orchestrator into the server process on
  `systemDb` with `createServerRuntime` (live pi.dev sessions, or the fake when
  `SKYLARK_FAKE_RUNTIME` is set), subscribes it to the ship's log, arms the
  waker, and ensures the notifications reactor runs. `v8 ignore`d.
- **Schedule** — a row in `chat_schedules`: a message queued to post itself into
  a chat later, one-shot (`fireAt`) or recurring (`intervalMinutes` with a
  `nextFireAt` advanced each fire), owned entirely by chat. It fires by posting
  a chat message AS its `authorId` — nothing else — so the reply rules do the
  rest. Schedules ride chat membership under RLS (migration 0027), so every
  member sees them: no invisible clockwork. Pure decision logic in `service.ts`
  (`canAuthorSchedule`, `scheduleTiming`, `isScheduleDue`, `advanceNextFire`);
  firing is `fireDueSchedules`.
- **The schedule sweep** — `orchestrator-live.ts` arms a recurring sweep (30s,
  on `systemDb`) that drains `fireDueSchedules`. Built on the shared
  `hull/lib/interval-sweep.ts` helper (an unref'd interval with an injected
  clock + timer, errors swallowed and logged) — the same helper the files sweep
  rides. `v8 ignore`d live wiring; the fire decisions are PGlite-tested.
- **Doors** — `server.ts` (the web doors; the front-door route is the chat UI)
  and `cli.ts` (`npm run chat`: `list`, `show <chatId> [--limit N]`,
  `post <chatId> <message>` — how a woken agent finds a chat and posts to it
  from its bash tool, mirroring the issues CLI's conventions exactly — plus
  `schedule new|list|rm` to manage scheduled messages from bash). The chat view
  carries a modest schedules affordance (list + create + enable/disable +
  delete); the CLI is the primary door for v1.

## Structure

**A message, end to end.** A human posts → `postChatMessage` writes the row
(durable immediately) and emits `chat.message_posted` (topic `chat:<id>`,
audience `members`) → the durable row + `pg_notify` reach the server's LISTEN
connection, which fans onto `shipLogBus` → the orchestrator's `handleBusNote`
reads the event, picks the target agents, and for each: ensures a backing
session, feeds it the messages it hasn't seen, runs a turn (streaming
`chat.agent_progress` for the live "working…" placeholder), then posts the
assistant's text as a new chat message — another `chat.message_posted` the
browser hears over SSE. The reply runs **off the bus, not inline**: the same
handler would hear a message posted from another process.

**Who answers.** Only a human's message triggers a reply (agents never trigger
agents, so a reply can't cascade into a loop). In a **1:1** (one human + one
agent) the agent always answers; in a **group** only the agents whose handle is
`@mentioned` do.

**A wake, end to end.** An agent files an issue from a chat
(`npm run issue -- new …`, no chat reference recorded — issues know nothing
about chat) → the work moves and the notifications reactor writes the agent an
inbox row → the waker's debounce gathers the flurry and calls the orchestrator's
`wake` with the whole batch briefed → a turn on the agent's own **inbox
session** (found by its well-known title, `agent/service.ts`'s
`findAgentSessionByTitle`, or created on first wake — a bare session, no chat,
`cwd` the repo root), prompted with the briefing plus instructions to find the
right conversation itself: use `npm run chat -- list`/`show` to locate the chat
where the work was planned, then `npm run chat -- post` to update it — or do
nothing if none fits. Then the batch is marked read. This is what closes the
planning loop: file → build → woken to review, post an update to the right chat,
and file the next piece — the routing judgment now lives with the agent, not the
plumbing.

**A schedule, end to end.** A member creates a schedule (web door or
`npm run chat -- schedule new`) → the create door checks the **author rule**
(the row's `authorId` must be the creating actor themself, or an **agent**
member of the chat — never another human) and the timing (exactly one of a
one-shot `fireAt` or a recurring `intervalMinutes` at/above the five-minute
floor) → the row lands, visible to every member. The live schedule sweep (30s,
`systemDb`) drains `fireDueSchedules`: for each due enabled row, in ONE
transaction, it posts a chat message AS the author — **nothing else** — AND
advances the row (consuming a one-shot by disabling it, kept as a record, or
advancing a recurring row's `nextFireAt`), so a crash between the two can't
refire it. After the commit it emits `chat.message_posted`, so the ordinary
reply path takes over: a **human**-authored fire draws agent replies (a
recurring task); an **agent**-authored one draws none (a standing announcement —
agents never trigger agents). This is the deliberate semantic: the author of the
schedule, not any new machinery, decides whether a fire is a task or an
announcement.

**Identity.** Every door resolves the acting user with `currentActor()` (see the
users zine) — you never tell the system it's you. Creating a chat always
includes you; messages are authored by you; an agent's reply is authored by that
agent.

## Decisions

- **Chat is hull, its view is rigging.** It's load-bearing — a front-door
  primitive other things will route through, with more planned — so the durable
  core lives in the hull; the _experience_ of it is a rigging view, freely
  customized.
- **Membership is visibility, enforced by RLS.** A chat's ship's-log events ride
  `chat:<id>`, and the SSE stream gates them through `canSeeTopic`, which
  **probes `chats` under the actor's RLS context** — deferring to the migration
  0007 policy rather than re-checking `chat_members` in code. The transcript
  doors run under `withActor` too, so their reads are RLS-filtered and the
  mutating doors' writes are gated by the `WITH CHECK` policy; the in-code
  `isMember` check is gone. The app connects as the non-superuser `app_user`
  (see hull/users/zine.md), so a chat is invisible to a non-member by
  construction, on every path.
- **One backing session per (chat, agent).** An agent's session accumulates the
  conversation, so we feed it only the messages posted since it last spoke. The
  session is recorded on the membership row and reused across turns for
  continuity; the chat transcript and the session transcript stay distinct.
- **Only assistant text crosses into the chat.** Thinking and tool calls stay in
  the agent session. The chat is for people; the session monitor (Agents view)
  is for watching the work.
- **The reply is event-driven, not inline — and that is the point.** Posting is
  durable the instant the row is written; the reply is driven off the ship's log
  by `handleBusNote`, not by an inline call from the web door. Same reasoning as
  the issues orchestrator: a message posted from another process (the chat CLI —
  an agent posting from its own bash tool) is still heard, because the trigger
  is a durable event, not an in-process call. A failed reply is logged, never
  blocks the post.
- **A wake drives the agent's own inbox session, never a chat directly.** The
  waker (and the notifications layer generally) knows nothing about which chat
  an update belongs in — that coupling used to live in `issues.originChatId` and
  has been removed. Instead a wake is a turn on a session keyed only to the
  agent (found by a well-known title, `findAgentSessionByTitle`), briefed on the
  batch and told to route it itself via the chat CLI. This is what let `issues`
  stop importing `chats` at all: the routing judgment moved from a foreign-key
  to the agent's own reasoning.
- **Startup reconciliation recovers an interrupted reply.** A
  `chat.message_posted` event reaches the subscription only live, so a human
  message posted just before a restart would leave a reply owed but undriven. On
  boot, `reconcile` re-drives the reply to each chat's latest human message;
  `reply`'s "unseen since the agent last spoke" check makes it idempotent, so a
  caught-up chat is untouched.

- **Firing is `addMessage` as the author, nothing else.** A schedule doesn't
  reimplement any reply logic — it posts, and posting already does the right
  thing. The author rule is what makes the semantic clean: because a schedule
  posts in its author's name, a human-authored one is a recurring task and an
  agent-authored one is a recurring announcement, purely by whose name is on it
  — and you may never put a schedule in another human's mouth.
- **A fire posts and advances atomically.** `fireDueSchedules` writes the
  message and advances the schedule (recurring → next slot, one-shot → disabled)
  in **one transaction**, then emits the `chat.message_posted` event only after
  it commits. So a crash between posting and advancing can't leave a row still
  due and refire it (no double post); a dropped emit only delays the live reply,
  which startup reconcile re-drives. Each row fires in its own transaction with
  its own try/catch, so one bad fire is logged and the sweep carries on rather
  than starving every later schedule.
- **Missed fires reconcile conservatively; the sweep is enough.** A row due
  while the ship was down fires **once** on the next sweep, and a recurring row
  advances past every missed slot to the next future one (`advanceNextFire`) —
  no backfill spam, no separate boot reconciler. The periodic sweep is the
  recovery path (pinned by a test that a long-overdue recurring row posts once,
  not once per missed slot).
- **The author rule is an app-door invariant, not RLS.** Unlike a chat message
  (whose `authorId` is always the actor), a schedule's `authorId` is chosen by
  the caller — so `canAuthorSchedule` at both doors (server.ts, cli.ts) is the
  sole guard against putting words in another human's mouth. RLS gates only
  visibility by membership; every write path MUST run the author check. Same for
  the timing XOR (`scheduleTiming`). Stated loudly here and in schema.ts so a
  future door can't quietly drop it.
- **The sweep timer is a shared, injected helper.** `hull/lib/interval-sweep.ts`
  owns the "unref'd interval, arm-once at the caller, swallow+log a failed tick"
  pattern with an injected clock and timer, so it's unit-tested without real
  time; both the chat schedule sweep and the files sweep ride it. arm-once stays
  the caller's job (the live shell's module singleton).

## Changelog

- **#l07u — Scheduled chat messages.** `chat_schedules` (one-shot or recurring),
  owned by chat, riding membership under RLS (migration 0027). Fires via chat's
  own `addMessage` as the author, so reply rules make a human-authored fire a
  task and an agent-authored one an announcement. CRUD web doors +
  `npm run chat -- schedule new|list|rm`, a modest schedules affordance in the
  chat view, and a shared `hull/lib/interval-sweep` helper the files sweep now
  shares too.
- **Decouple issues from chat** — `wake` now drives the agent's own inbox
  session (found by a well-known title) instead of a chat determined by
  `issues.originChatId` (removed). The waker debounces one wake per agent,
  briefed on the whole batch; the agent finds the right chat itself with the new
  `npm run chat` CLI (`list`/`show`/`post`) and posts an update, or does nothing
  if none fits.
- **LLM gateway** — chat sessions boot on the ship default model; `CHAT_MODEL`
  retired.
- **#67** — The wake loop: `wake` on the orchestrator, the debounced per-(agent,
  origin-chat) waker, `turnContext` on every turn, and chat sessions booting on
  `CHAT_MODEL`.
- **#2** — The reply path moves onto the ship's log (`handleBusNote` +
  `reconcile`), booted by `orchestrator-live.ts`.
- **#1** — The chat service: chats, members (= visibility), messages, response
  rules (1:1 auto, group @mention), backing agent sessions, the front-door view.
