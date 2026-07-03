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
- **turnContext** — the situational header every agent turn opens with: who the
  agent is, which chat this is, and the concrete
  `npm run issue -- new … --chat <id>` command for filing work (which is what
  routes the issue's notifications back to this conversation). Repeated per turn
  — cheap, and it survives session compaction.
- **The waker** (`waker.ts`) — the bridge from notifications to a sleeping
  agent: debounces a flurry (10s) into one wake per (agent, origin chat), routes
  each notification to its issue's `originChatId`, and drives the orchestrator's
  `wake` with the batch briefed. A batch is marked read only AFTER its wake
  succeeds — a failed wake leaves the rows unread to retry; notifications with
  no route home are consumed without a wake.
- **CHAT_MODEL** — a chat agent's backing session boots with the strong model:
  `SKYLARK_CHAT_MODEL`, else the preferred hosted model when its provider key
  exists, else the local default (`chatModelRef` in the agent service). Chat is
  the planning surface; builders stay on `DEFAULT_MODEL`.
- **The live shell** (`orchestrator-live.ts`) — the impure wiring:
  `ensureChatOrchestrator` boots the orchestrator into the server process on
  `systemDb` with `createServerRuntime` (live pi.dev sessions, or the fake when
  `SKYLARK_FAKE_RUNTIME` is set), subscribes it to the ship's log, arms the
  waker, and ensures the notifications reactor runs. `v8 ignore`d.
- **Doors** — `server.ts` (the web doors; the front-door route is the chat UI).

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

**A wake, end to end.** An agent files an issue from a chat (`--chat` records
the provenance) → the work moves and the notifications reactor writes the agent
an inbox row → the waker's debounce gathers the flurry, groups it by the issue's
`originChatId`, and calls the orchestrator's `wake` → a normal turn on the
agent's backing session, prompted with the briefing (plus any chat messages it
hasn't seen), whose reply lands in the chat like any other. Then the batch is
marked read. This is what closes the planning loop: file → build → woken to
review and file the next piece.

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
  the issues orchestrator: a message that arrives from another process (a future
  chat CLI, an agent posting elsewhere) is still heard, because the trigger is a
  durable event, not an in-process call. A failed reply is logged, never blocks
  the post.
- **Startup reconciliation recovers an interrupted reply.** A
  `chat.message_posted` event reaches the subscription only live, so a human
  message posted just before a restart would leave a reply owed but undriven. On
  boot, `reconcile` re-drives the reply to each chat's latest human message;
  `reply`'s "unseen since the agent last spoke" check makes it idempotent, so a
  caught-up chat is untouched.

## Changelog

- **#67** — The wake loop: `wake` on the orchestrator, the debounced per-(agent,
  origin-chat) waker, `turnContext` on every turn, and chat sessions booting on
  `CHAT_MODEL`.
- **#2** — The reply path moves onto the ship's log (`handleBusNote` +
  `reconcile`), booted by `orchestrator-live.ts`.
- **#1** — The chat service: chats, members (= visibility), messages, response
  rules (1:1 auto, group @mention), backing agent sessions, the front-door view.
