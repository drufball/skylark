# Chat

_chat zine — issue #cse1_

## tl;dr

Chat is the ship's front door: conversations between the crew — humans and
agents. A chat is a set of **members**, and **membership is visibility**: only
members see a chat, and an added member sees the whole history (no per-message
ACL). Agents are members too; when one needs to speak, the chat orchestrator
drives its backing agent session and posts the reply back as a chat message.

A chat also carries **widgets** — live little views the crew keeps open
together, in a stack above the composer. A widget instance is not data; it's a
piece of the conversation.

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
  own tables (plus a read-join onto users for display).
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
- **Widget** — a row in `chat_widgets`: a live little view kept open inside one
  chat. A `kind` plus an opaque `props` blob, a `placement` (only `stack` so far
  — above the composer), a `stackOrder`, and a nullable `dismissedAt`. A widget
  instance **always lives in exactly one chat**; nothing else ever owns one, so
  its lifetime is the conversation's lifetime (an FK cascade, not a cleanup job)
  and its access is the conversation's access (membership under RLS, migration
  0031). Its CONTENTS are fetched fresh on render and never stored on the row.
- **Widget kinds** (`widgets.ts`) — the pure, node-free meaning of a `props`
  blob, shared by the doors and the view. `parseProps(kind, json)` is **total**:
  it returns a fully-typed `props` or an honest refusal (`unknown-kind` /
  `bad-props`), never a throw. One kind so far: **`choice`**
  (`{ question, options[] }`; yes/no is just `options: ['Yes','No']`), which
  needs nothing from any other service. `answerOptions` is the whitelist an
  answer is checked against; `answerMessageBody` composes the message an answer
  posts.
- **Dismissal** — `dismissedAt` set. The widget leaves the stack; the row
  survives as history — what was asked, of whom, and when it stopped being open.
- **Doors** — `server.ts` (the web doors; the front-door route is the chat UI)
  and `cli.ts` (`npm run chat`: `list`, `show <chatId> [--limit N]`,
  `post <chatId> <message>` — how a woken agent finds a chat and posts to it
  from its bash tool, mirroring the issues CLI's conventions exactly — plus
  `schedule new|list|rm` to manage scheduled messages from bash, and
  `widget new|list|answer|dismiss|reorder` to put a live view in front of the
  crew). The chat view carries a modest schedules affordance (list + create +
  enable/disable + delete); the CLI is the primary door for v1. The **web**
  widget doors are only what a browser needs — read the stack, answer, wave away
  — because raising and reordering are agent moves and the CLI is their door.

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

**A widget, end to end.** An actor raises one (`npm run chat -- widget new`, or
a web door) → the row lands in the actor's own name and a `chat.widget_changed`
event goes out on the chat's **existing** `chat:<id>` topic, so every member's
open browser refreshes the stack off the stream it was already listening on. The
view renders each row through `parseProps`: a good blob becomes a **compact**
tile (the question, clamped to two lines) that expands into tappable option
buttons; a bad blob or an unknown kind becomes an honest tile that says which it
is and can still be dismissed. Answering **posts an ordinary chat message as the
answering actor** and sets `dismissedAt` — in ONE transaction, the dismissal
conditional on `dismissed_at is null` so a double submit rolls back instead of
posting twice. Then the ordinary reply path takes over, with no widget-specific
machinery anywhere in it.

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

- **A service must never raise a widget.** Only an **actor with judgment** — an
  agent or a human, through a door, from its own turn — puts a widget in front
  of a person. No service reaches into `chat_widgets` to ask something on its
  own behalf, and none ever should: the moment one does, every service that
  wants a human's attention needs a path into chat, and the graph re-tangles
  (which is exactly what `architecture.test.ts`'s ban on issues→chat imports
  exists to prevent). A service that needs an answer emits on the ship's log; an
  agent hears it, decides it's worth interrupting a human for, and raises the
  widget itself. The `createdById` column is that rule made visible — every
  widget has somebody's name on it.
- **Widgets live in chat, not in a service of their own.** Half a widget row's
  identity IS a chat id: a widget instance always belongs to exactly one chat
  and nothing else ever owns one. Owning the table here means no new entry in
  `SCHEMA_FK_ALLOWLIST` and no new cross-service coupling — and the
  never-orphaned invariant is a plain `on delete cascade` rather than a sweep.
- **A widget instance is not data — it's a piece of the conversation.** It's a
  lens some crew agreed to keep open together, so it inherits the conversation's
  lifetime, the conversation's access, and nothing else. Its **contents are
  fetched fresh on render and never stored on the row** — the row holds only
  what the crew chose (which lens, configured how), never a snapshot of what the
  lens was showing. A widget that persisted its contents would be a stale cache
  nobody asked for.
- **Answering posts an ORDINARY chat message — that's the whole feature.** No
  answer table, no answer delivery path. Because the answer is a chat message
  authored by the answering actor, the unseen-message diffing, reply targeting,
  the no-agent-cascade rule, RLS, SSE delivery and startup reconcile all apply
  with **zero new code** — the same reasoning that makes a schedule fire by
  calling `addMessage` and nothing else. The message quotes the question above
  the answer, so the transcript still reads as a question-and-answer long after
  the widget row has left the stack.
- **The row knows nothing about kinds, and `parseProps` never throws.** `kind`
  and `props` are opaque to the table, and a bad blob is stored, not refused —
  because whoever wrote it (usually an agent) has to be able to SEE what they
  got wrong, and a rejected write teaches them nothing. So the two honest
  failure tiles ("these props don't parse", "this ship doesn't know this widget
  kind") are designed states, not error handling: later slices let kinds be
  defined per ship, so rows WILL outlive their definitions and must say so out
  loud.
- **Widget changes ride the chat's existing topic.** `chat.widget_changed` goes
  out on `chat:<id>`, the topic every member's browser already subscribes to for
  messages — so the stack goes live with no new transport, no new subscription,
  and no polling. Every mutation announces itself from the SERVICE, not the
  door, so a second door can't ship a change nobody's browser hears.
- **The stack is a shelf, not a second pane.** It's height-capped and
  scrollable, and only one widget expands at a time, so however many widgets are
  open they cannot push the message thread off a phone screen. A widget lives
  above the composer — where the next thing you'd touch belongs — and never
  becomes its own route, pane or screen.

## Changelog

- **#cse1 — Widgets in chat.** `chat_widgets` (migration 0030, RLS 0031) owned
  by chat: a `kind` + opaque `props`, stacked above the composer, ordered by
  `stackOrder`, dismissed rows kept as history. One kind, `choice`. Prop parsing
  is pure and total (`widgets.ts`), so a malformed blob or an unknown kind
  renders an honest tile. Answering posts an ordinary chat message as the
  answering actor and dismisses the widget atomically, so every existing
  reply/delivery rule applies untouched. Web doors for read/answer/dismiss,
  `npm run chat -- widget new|list|answer|dismiss|reorder` for the rest, live
  over the existing `chat:<id>` topic.
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
