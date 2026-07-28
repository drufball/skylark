# Chat

_chat zine — issue #cse4_

## tl;dr

Chat is the ship's front door: conversations between the crew — humans and
agents. A chat is a set of **members**, and **membership is visibility**: only
members see a chat, and an added member sees the whole history (no per-message
ACL). Agents are members too; when one needs to speak, the chat orchestrator
drives its backing agent session — and **the agent speaks for itself**, by
calling `chat_post` from inside its own turn. Chat posts nothing on anybody's
behalf.

A chat also carries **widgets** — live little views the crew keeps open together
— on two surfaces. The **stack** above the composer is turn-shaped: ephemeral,
answer-shaped things an agent needs from you right now. The **canvas** is
state-shaped: pages of readouts and controls the crew arranged, beside the
thread, staying where they were put. A widget instance is not data; it's a piece
of the conversation, and it crosses between the two surfaces by an ordinary row
update. Agents raise and place them from their own turns (`chat_widget`), which
is how a question with known answers becomes one tap instead of a sentence — and
how a chat becomes the app you and these people built for this task, with the
agent right there beside it.

The one idea that shapes everything: **the clean chat transcript and the agent's
full tool-call transcript are two surfaces over one conversation.** The seam
between them is the agent's own tool call: what it decides to say crosses into
the chat, and its thinking, reading and building stay in the agent session
(visible in the Agents view). Chat lives in the hull — it's load-bearing and
drives the ship's residents, like the issues board does — with its view in the
rigging.

## Components

- **Chat** — one conversation, a row in `chats`: an optional title and an
  activity clock that orders the sidebar. Named by its members when untitled.
- **Member** — a row in `chat_members`, one per (chat, user). The visibility
  list. For an agent member, `sessionId` points at its backing agent session for
  this chat (created lazily on first reply, kept for continuity), and
  `lastSeenMessageId` is how far its turns have READ (migration 0032) — advanced
  at turn end whether or not it chose to speak.
- **Message** — a row in `chat_messages`: a member's text, ordered by UUIDv7 id.
- **Service logic** (`service.ts`) — pure persistence + the pure response rules
  (`parseMentions`, `targetsForMessage`, `formatTranscript`). Touches only its
  own tables (plus a read-join onto users for display).
- **Orchestrator** (`orchestrator.ts`) — **dispatch, not ventriloquism.** It
  turns a posted message into agent turns: who should answer, feed each one what
  it hasn't read, run the turn, show a progress line, mark how far it read. It
  never posts a message. `handleBusNote` is its ship-log subscription (a posted
  message drives the reply); `wake` runs a briefing turn when a notification
  arrives; `reconcile` is startup recovery. Injected runtime, so the decisions
  are unit-tested against PGlite with a fake.
- **Session tools** (`session-tools.ts`) — the agent-facing door: `chat_post`
  (say something) and `chat_widget` (raise/reorder/dismiss a widget), registered
  on the backing session by the runtime's `sessionTools` seam. Every call runs
  under the AGENT's own actor, so it goes through the same membership policy a
  human's tap does. A session that backs no chat membership gets no tools at
  all.
- **turnContext** — the situational header every reply turn opens with: who the
  agent is, which chat this is, **how to speak** (`chat_post` is the only way
  anything reaches the crew; silence is allowed), the structured alternative
  (`chat_widget`), and the concrete `npm run issue -- new … --body …` command
  for filing work. Repeated per turn — cheap, and it survives session
  compaction. This header is the only thing standing between a resident agent
  and total silence, so it is load-bearing prose, not decoration.
  `inboxTurnContext` is its counterpart for a wake turn: it opens instead with
  "this is your inbox, not a chat" and the chat-CLI commands
  (`list`/`show`/`post`) for finding and updating the right conversation — an
  inbox session has no chat, so it has no `chat_post` either.
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
- **The row's answer contract** (`widgets.ts`) — the pure, node-free half of a
  widget the HULL keeps: `offeredAnswer(props)` reads the question and the exact
  values a row will accept back, structurally (a filled `question` plus a
  non-empty `options` list of non-empty strings) and **without knowing any kind
  by name**; `answerMessageBody` composes the message an answer posts — the
  question, then the answer marked with `→`, in plain characters, because the
  thread renders a body verbatim and markdown would arrive as punctuation; and
  `answerDismisses(placement)` says whether answering takes the tile off its
  surface (see the decision below). Total: every input returns an offer or null,
  nothing throws. A kind that offers no answers (a `note`, an `issue-list`)
  simply has no options on its blob, so answering it is refused for free — and
  so is answering a blob an agent malformed.
- **Canvas page** — a row in `chat_canvas_pages`: one page of a chat's canvas,
  with a title and a place in the strip. Pages are EXPLICIT rows rather than
  implied by whichever widgets carry a page number, because the two things we
  most want are impossible otherwise: an empty page you just made, and a page
  with a name and an order. Rides chat membership under RLS (migration 0034),
  deferring to migration 0007's `app_can_see_chat` like every other chat-scoped
  table. Removing one is refused while it still holds widgets.
- **Placement** — `chat_widgets.placement`, the discriminator: `stack` or
  `canvas`. A canvas row also carries `pageId` and a cell rectangle
  (`gridX/gridY/gridW/gridH`), clamped into a four-column grid by
  `clampCanvasBox` at every door. Moving between surfaces is `placeWidget` /
  `stackWidget` — one update, no special mechanism.
- **Canvas geometry** (`widgets.ts`) — the pure, node-free arithmetic BOTH sides
  need: `CANVAS_COLUMNS`, `clampCanvasBox` (whole cells, never off an edge),
  `nextCanvasSlot` (the first free cell, left-to-right then down) and
  `freeCanvasBox` (the box you asked for, or the first free one of that size).
  The doors clamp with it and the browser draws from it, so a dragged tile and a
  stored row cannot disagree.
- **View state** — a row in `chat_view_state`, one per (chat, user): the canvas
  page THIS person has open. Per viewer, never per chat (see the decision
  below); persisted so a reload puts you back; read by the orchestrator to brief
  an agent about the person it's answering. Its RLS policy adds a second clause
  to membership — `user_id` must be the acting user — so no actor, agent
  included, can read or move somebody else's view.
- **Widget kinds** — what a `kind` MEANS (how it renders, what its props are,
  which topics keep it live) is the rigging **catalog**'s, not the hull's:
  [`rigging/widgets/zine.md`](../../rigging/widgets/zine.md). Three kinds today
  — `choice`, `note`, `issue-list`. **Hull holds the row; rigging holds the
  meaning** (see the decision below for the cycle that forces it).
- **The widget catalog seam** (`widget-catalog.ts`) — `registerWidgetKinds` /
  `knownWidgetKinds` / `describeWidgetKinds` / `validateWidgetProps`. The hull
  may not import the rigging catalog, but `chat_widget` has to TELL an agent
  which kinds exist, so the composition root (`src/boot.ts`) hands the
  vocabulary down at boot and this module holds it. The tool's description is
  GENERATED from it, so a kind added to the catalog is described in one place,
  not two.
- **Dismissal** — `dismissedAt` set. The widget leaves the stack; the row
  survives as history — what was asked, of whom, and when it stopped being open.
- **The decision** — `answeredAt` + `answerValue` (migration 0035). Distinct
  from `dismissedAt` because the two surfaces disagree about what answering
  DOES: on the stack an answered widget also leaves, on a canvas it stays and
  shows what was decided. `answered_at is null` is now the guard that serializes
  a double submit, since a dismissal no longer always follows.
- **Doors** — three, and each has a body it belongs to. `server.ts` (the **web**
  doors; the front-door route is the chat UI: read the stack, answer, wave away,
  and — because arranging IS a browser move — the canvas reads, the page CRUD,
  `placeChatWidget`/`stackChatWidget` and `setChatViewPage`). `session-tools.ts`
  (the **agent** doors, from inside a turn: `chat_post`, `chat_widget`).
  `cli.ts` (`npm run chat`, the **human/debug** door and the only one a session
  with no chat has: `list`, `show <chatId> [--limit N]`,
  `post <chatId> <message>` — how a woken agent on its inbox session finds a
  chat and posts to it from bash — plus `schedule new|list|rm`,
  `widget new|list|answer|dismiss|reorder|place|stack` and
  `page new|list|rename|rm`). The chat view carries a modest schedules
  affordance (list + create + enable/disable + delete).

## Structure

**A message, end to end.** A human posts → `postChatMessage` writes the row
(durable immediately) and emits `chat.message_posted` (topic `chat:<id>`,
audience `members`) → the durable row + `pg_notify` reach the server's LISTEN
connection, which fans onto `shipLogBus` → the orchestrator's `handleBusNote`
reads the event, picks the target agents, and for each: ensures a backing
session, feeds it the messages it hasn't read, and runs a turn (streaming
`chat.agent_progress` for the live "working…" line). **Whatever the agent
decides to say, it says itself, mid-turn, by calling `chat_post`** — which
writes an ordinary message row and emits its own `chat.message_posted`, so the
browser hears it over SSE the instant it lands rather than at the end of the
turn. When the turn ends the orchestrator clears the progress line and advances
the member's `lastSeenMessageId`. The reply runs **off the bus, not inline**:
the same handler would hear a message posted from another process.

**Who answers.** Only a human's message triggers a reply (agents never trigger
agents, so a reply can't cascade into a loop — including an agent's own post
that @mentions another agent, since `targetsForMessage` filters on the author,
not the text). In a **1:1** (one human + one agent) the agent always answers; in
a **group** only the agents whose handle is `@mentioned` do.

**How far an agent has read.** `messagesSinceAgent` resolves a watermark as the
**later of two things**: the `lastSeenMessageId` the orchestrator advances at
turn end, and the last message the agent itself authored. Both halves earn their
keep, and the pair is what makes either crash ordering safe — see the decision
below.

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

**A widget, end to end.** An actor raises one — an **agent from its own turn**
(`chat_widget`, the usual case), or a human from `npm run chat -- widget new` →
the row lands in the actor's own name and a `chat.widget_changed` event goes out
on the chat's **existing** `chat:<id>` topic, so every member's open browser
refreshes the stack off the stream it was already listening on. The view renders
each row through the rigging catalog's `resolveWidget`: a good blob becomes a
**compact** tile (the kind's headline, clamped to two lines) that expands into
the kind's own body — tappable option buttons for a `choice`, a markdown card
for a `note`, a live list for an `issue-list`; a bad blob or an unknown kind
becomes an honest tile that says which it is and can still be dismissed. A kind
that reads a service reads it FRESH on render (never off the row) and stays live
off the topics it declares, on the one subscription the stack holds. Answering
**posts an ordinary chat message as the answering actor** and marks the row
answered — in ONE transaction, conditional on `answered_at is null` so a double
submit rolls back instead of posting twice. Whether it ALSO leaves the surface
is `answerDismisses(placement)`: yes on the stack, no on a canvas. Then the
ordinary reply path takes over, with no widget-specific machinery anywhere in
it: the answer is just a message, so the agent's next turn sees it in its unread
tail and answers with `chat_post`. **That loop — an agent raises a question, a
thumb taps it on a phone, the answer arrives as a message, the agent responds —
is the whole thesis of the project in one interaction.**

**A canvas, end to end.** Somebody makes a page (`chat_widget` action
`new_page`, the `+` in the page strip, or `npm run chat -- page new`) → the row
lands and a `chat.canvas_changed` event goes out on the chat's **existing**
`chat:<id>` topic, so every member's open browser refreshes its page strip. A
widget gets onto it by an ordinary update: the crew pins one down from the stack
(the tile's canvas button), drags or resizes it once it's there, or an agent
calls `chat_widget` with `place`. Every one of those paths lands in
`placeWidget`, which clamps the box into the grid and — if those cells are
already occupied — puts the tile in the first free slot instead, so the canvas
never draws two tiles on top of each other. The row announces itself as
`chat.widget_changed` with change `placed`. On a desktop pane the page is a grid
you arrange beside the thread; on a phone the same page is one column in
arrangement order (`gridY` then `gridX` — the order the read already uses), with
the pages swipeable and tabbable. See
[`rigging/widgets/zine.md`](../../rigging/widgets/zine.md) for the two layouts.

**Which page you're looking at.** Opening a page writes YOUR `chat_view_state`
row and nothing else — no event, no invalidation for anyone else. When the
orchestrator builds a reply turn it reads `listChatViewers` and tells the agent
which page each human has open, so "what's this?" is answerable; the same
paragraph tells the agent it cannot move anybody's view.

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
- **The agent speaks; chat does not speak for it.** Chat used to filter a
  finished turn's transcript for assistant text and post that into the
  conversation. That was a codec sitting between an agent and its own words: it
  had to track every SDK message-shape change, it could only speak once and only
  at the very end, and it could not tell "the agent had nothing to say" from
  "the shape changed under us". Now the agent calls `chat_post` from inside its
  turn. What crosses into the chat is what the agent CHOSE to say — not what a
  filter could recognise. `toChatItems` still exists, but only the Agents
  monitor view uses it (to render a full transcript); chat has no opinion about
  transcript shapes at all any more.
- **A session tool, not the CLI — because the CLI would make speaking
  BUDGETED.** `npm run chat -- post` was right there and it is the wrong door
  for a chat turn. It runs in the bash tool, and every foreground tool call is
  wrapped by the wall-clock tool budget (agent/tool-budget.ts): speaking would
  be budgeted like a build, and an agent whose post lost that race would go
  **mute, with nothing in the chat to say why** — a silent failure that is agony
  to debug. A registered tool is also one insert on a connection we already
  hold, instead of a child process, npm's startup, a fresh connection and an
  actor resolve per reply; and the call lands in the session transcript, which
  is exactly where "two surfaces over one conversation" says it belongs. (Honest
  edge: the budget still wraps `chat_post` too, since exempting it would need
  chat to reach into the agent's exemption list. A single insert cannot
  plausibly spend ten minutes, and if it somehow did the agent gets an errored
  tool result it can see and retry — which is the difference that matters.) The
  CLI stays as the human/debug door, and remains the ONLY door on an inbox
  session, which has no chat to speak into.
- **The agent's door runs as the agent, never on `systemDb`.** The orchestrator
  is fixed plumbing and rides the superuser connection; the tools it registers
  do not. `createChatSessionTools` is handed `withActor`, so an agent's post,
  raise, reorder and even the "which chat is this session for?" lookup all run
  under that agent's own RLS context. So the agent's door is gated by exactly
  the policy a human's tap is gated by (membership is visibility,
  migration 0007) rather than by code remembering to check — and an LLM-driven
  path never touches `systemDb`.
- **Tools are contributed by the host, not imported by the agent service.** The
  runtime gained a `sessionTools` seam (`SessionToolsProvider`) and chat passes
  its own provider in `orchestrator-live.ts`. The dependency direction stays
  chat → agent, with no chat import anywhere in the hull's agent service. The
  provider resolves at session BOOT, from the membership row that points at the
  session — so a session that backs no chat (an inbox session, a builder's) gets
  an empty list and the tool simply doesn't exist there, rather than existing
  and failing when called.
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
  `reply`'s "unread by this agent" check makes it idempotent, so a caught-up
  chat is untouched.
- **The seen watermark is TWO halves, `max`'d — and that's what makes both crash
  orderings safe.** `messagesSinceAgent` takes the later of
  `chat_members.last_seen_message_id` (advanced by the orchestrator at turn end)
  and the last message the agent itself authored. Each half covers the other's
  crash:
  - Lose the **watermark write** after the agent's post committed → the post is
    still the watermark, so reconcile does not re-drive a turn that already
    spoke. **No duplicate message in the crew's face** — the outcome we chose to
    be safe against, because a doubled reply is visible, confusing and
    unfixable, while a re-read is merely wasteful.
  - Lose the **post** because the turn ended in silence → the watermark still
    marks what was read, so those messages aren't re-fed forever. Before the
    inversion a silent turn was rare; now it's first-class, which is exactly why
    the column had to exist.
  - Both are pinned by tests, in both orderings. The advance is **monotonic** (a
    stale write is ignored), because a queued call returns before the turn it
    was folded into and the two can finish out of order. And it advances to the
    tail the turn was FED, not to whatever is newest — a message that landed
    mid-turn was never shown to the agent, so it draws its own turn.
- **The progress line means "mid-turn", and nothing more.** It used to double as
  a promise: the reply always arrived last, so "working…" reliably meant "a
  message is coming". After the inversion an agent may post at second 5 and keep
  working until second 40, or work for a minute and say nothing. So the bubble
  is a status line, not an empty message envelope — the copy reads
  `@tilde is working — using bash…`, never "typing…" — and a message appearing
  above a still-spinning line is CORRECT rather than a glitch. It clears when
  the turn ends.
- **Silence is deliberate; nothing is auto-posted to cover it.** A turn that
  ends without a post posts nothing — a fallback "ok!" would reinstate the exact
  ventriloquism this slice deleted, and would put words in an agent's mouth that
  it declined to say. What the thread shows instead is the one fact we actually
  have, from the watermark we already keep: **`Seen by @tilde`**, when an
  agent's turn read the last message and didn't answer it. It's a read receipt,
  not a message: no row, no author, no transcript entry — so unexplained silence
  stops reading as a broken ship without anyone pretending to speak.

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

- **Raising is the raiser's move, so the raiser needs a door.** Slice #cse1 left
  `add`/`reorder` CLI-only, which meant the one actor with judgment about when
  to interrupt a human couldn't do it from its own turn — the affordance existed
  for everyone except its intended user. `chat_widget` is that door. The web
  doors stay only what a BROWSER needs (read, answer, wave away), so there's no
  unused server fn sitting there for something a browser never does.
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
- **On a canvas, an answered choice STAYS and shows its decision.** The
  `answer ⇒ dismiss` contract is right for the turn-shaped stack and wrong for
  the state-shaped canvas: answering a choice somebody had pinned to a page made
  the tile vanish, punching a hole in an arrangement they made. On a spatial
  surface an answered question IS state, so the row keeps `answeredAt` +
  `answerValue` and the tile renders the decision (`Ship it? → Yes`). The
  distinction lives in the ROW's contract — `answerDismisses(placement)`, total
  and pure, defaulting an unrecognised surface to turn-shaped — rather than in
  whichever component draws the tile, because a rendering trick would be a
  second opinion about what a row means. It also forced the double-submit guard
  to move from `dismissed_at is null` to `answered_at is null`, which is the
  honest predicate either way.
- **Answering posts an ORDINARY chat message — that's the whole feature.** No
  answer table, no answer delivery path. Because the answer is a chat message
  authored by the answering actor, the unseen-message diffing, reply targeting,
  the no-agent-cascade rule, RLS, SSE delivery and startup reconcile all apply
  with **zero new code** — the same reasoning that makes a schedule fire by
  calling `addMessage` and nothing else. The message quotes the question above
  the answer, so the transcript still reads as a question-and-answer long after
  the widget row has left the stack.
- **Hull holds the row; rigging holds the meaning.** The `chat_widgets` table is
  a `kind` string and an opaque `props` blob, and the hull keeps exactly one
  opinion about what's inside: the **answer convention** every answerable kind
  spells the same way (`offeredAnswer`), which is a property of the ROW, not of
  a kind. Everything else — the component, the prop grammar, the ship-log topics
  — lives in the rigging catalog, because the catalog has to know every
  service's topic grammar and read every service's data. In `src/hull/widgets/`
  that would make the hull import every service with a widget, and the day
  `issues` wants one you get `hull/issues → hull/widgets → hull/issues` — a
  cycle `src/architecture.test.ts` fails the build over, correctly. Rigging may
  import every hull service freely; that's `home → rigging → hull` working as
  designed. The sharpest form of the argument: `issue-list`'s parser validates
  its `statuses` against the ISSUES service's own status vocabulary, which
  `hull/chat` may not import at all.
- **The row knows nothing about kinds, and nothing about them ever throws.**
  `kind` and `props` are opaque to the table, and a bad blob is stored, not
  refused — because whoever wrote it (usually an agent) has to be able to SEE
  what they got wrong, and a rejected write teaches them nothing. So the two
  honest failure tiles ("these props don't parse", "this ship doesn't know this
  widget kind") are designed states, not error handling: later slices let kinds
  be defined per ship, so rows WILL outlive their definitions and must say so
  out loud.
- **Widget changes ride the chat's existing topic.** `chat.widget_changed` goes
  out on `chat:<id>`, the topic every member's browser already subscribes to for
  messages — so the stack goes live with no new transport, no new subscription,
  and no polling. Every mutation announces itself from the SERVICE, not the
  door, so a second door can't ship a change nobody's browser hears.
- **The vocabulary is injected at the composition root, not imported.** The
  agent's door needs kind names and prop shapes; the hull may not reach up for
  them. `src/boot.ts` calls `registerWidgetKinds(widgetKindSpecs())` at server
  start, and `chat_widget` reads the catalog at CALL time (not tool-definition
  time), so there's no boot-order trap and a re-registration is picked up. An
  unregistered catalog refuses every raise **loudly** rather than quietly
  storing rows nothing can render — the failure it would otherwise cause is far
  harder to see than an error in a tool result.
- **The `chat_widget` tool takes `kind` + free-form `props`, not one kind's
  fields.** Slice #cse2 froze `question`/`options` into the signature, which
  made it a choice-only tool by construction. The shape now follows the row's
  shape, and `prepareArguments` absorbs the three mistakes models actually make
  on the way in (stringified props, a stringified nested list, the whole blob
  flattened beside `action`) — same reasoning as the original shim: the failure
  it prevents is a question that never reaches a human's thumb.
- **The stack is turn-shaped; the canvas is state-shaped.** That division of
  labour is the design rule, and it's what stops the two surfaces collapsing
  into one pile of widgets. The **stack** holds what an agent needs from you
  RIGHT NOW — a question with known answers, a glance before it acts — and it
  clears as you deal with it. The **canvas** holds what you decided is worth
  keeping in front of you: readouts and controls you arranged, on named pages,
  which stay put. When you ask "which surface?", ask "does this expire when it's
  been dealt with?" A widget crosses between them by updating `placement` — an
  ordinary write, deliberately not a special mechanism, because that same write
  is how an agent RAISES a canvas widget for attention (`stack`) without any
  separate alert channel existing.
- **The canvas lives INSIDE the chat, and is not a destination.** On a desktop
  pane it sits beside the message thread; on a phone, where they cannot both
  fit, a Thread/Canvas toggle in the chat's own header switches between them and
  the composer stays under both. There is no third route and no free-floating
  pane that retargets to a different chat — an earlier design with one was
  rejected for being confusing. The point of the whole surface is that you never
  leave the conversation to look at the thing you built, so the moment the
  canvas becomes somewhere you GO, it has lost the argument.
- **On a phone the shelf goes with the thread, and the toggle carries its
  count.** The stack is turn-shaped, so it belongs to the surface the turn is
  on. Left under the canvas as well it took a quarter of a 390px screen away
  from the surface you had deliberately switched to — two height-capped bands
  and a wrapped header, and the canvas got barely a third of the phone. So the
  phone's canvas surface hides the shelf and the Thread half of the toggle shows
  how many widgets are waiting, which is the one thing you would otherwise lose:
  a raise you never saw. The composer still sits under both, and a desktop pane
  still shows all three at once, because there it fits.
- **Which page you're looking at is a property of the PERSON, not the chat.**
  Three people in one chat can be on three different pages, so `chat_view_state`
  is keyed by (chat, user) and its RLS policy adds `user_id = the acting user`
  on top of membership. Chat-wide "current page" state would mean every tab
  someone else taps drags your view with it — a shared cursor nobody asked for.
  Two things follow and are load-bearing: changing your view emits NO ship-log
  event (your attention is not news for the crew, and an event would make it
  so), and no door lets an actor write another's row. **An agent cannot move
  your view in this slice** — the turn context says so out loud, and there is no
  tool action for it — because agent-driven focus is a later, carefully-designed
  thing, and getting it wrong means the ship yanks a page out from under
  somebody mid-sentence.
- **A canvas widget's box is clamped, and never allowed to overlap.** Agents
  write coordinates by hand and overshoot, and a drag can land on an occupied
  cell; both are refused-by-adjustment rather than refused outright, because a
  write whose result the author never sees teaches them nothing (the same
  reasoning that stores a malformed props blob). CSS grid will happily stack two
  tiles, and the result reads as a rendering bug rather than a layout — observed
  live — so `freeCanvasBox` makes the tile being MOVED yield to the first free
  slot. The tiles already on the page are never shoved around: somebody laid
  them out.
- **A page is a row, and only an EMPTY one can be removed.** Explicit pages are
  what make an empty page and a renamed page possible at all. Deleting one that
  still holds widgets is refused at the door rather than cascading them away —
  tidying up your tabs must never be the thing that destroys somebody's
  arrangement. The FK cascade underneath is a backstop for the chat's own
  deletion, not the path a human takes.
- **The stack is a shelf, not a second pane.** It's height-capped and
  scrollable, and only one widget expands at a time, so however many widgets are
  open they cannot push the message thread off a phone screen. A widget lives
  above the composer — where the next thing you'd touch belongs — and never
  becomes its own route, pane or screen.

## Changelog

- **#cse6 — The home canvas, and two carry-overs.** Widgets still live only in
  chats; what's new is a personal surface that POINTS at them
  ([`hull/home-canvas/zine.md`](../home-canvas/zine.md)), resolving each pointer
  against the viewer's current membership by calling chat's own reads
  (`listWidgetsByIds`, `listOpenWidgetsForChats`). Answering from home is
  `answerChatWidget` — the same door, no parallel path. Two carry-overs from the
  integrated pass land here: an answered choice on a CANVAS now stays put and
  shows its decision (`answeredAt`/`answerValue`, migration 0035, gated by the
  new `answerDismisses`), and widget controls stopped reading their `aria-label`
  off the row's primary key.
- **#cse5 — One product on a phone.** The integrated pass over #cse1–#cse4,
  driven at 390px: the four slices were each right alone and collided in the
  header, where the title, the Thread/Canvas toggle, Schedules and a chip per
  member wrapped to four rows and spent a quarter of the screen before anything
  in the conversation got a pixel. The header folds to two rows (the roster
  behind a count, Schedules down to its icon); the phone's canvas surface hides
  the turn-shaped shelf and the Thread toggle carries the waiting count; the
  working line follows the composer so an agent mid-turn isn't silent on the
  canvas; a chat with nothing in it says so instead of showing a void; and
  `answerMessageBody` stops composing a markdown blockquote the thread was
  rendering as a literal `> `. One real bug: answering from the canvas had no
  double-tap guard (the stack's), so a second tap in the window between the
  write returning and the refetch landing reached the door and came back as an
  uncaught refusal — the guard is now shared by both surfaces, and the route
  keeps `busy` on across the invalidate that closes the window at the source.
- **#cse4 — The chat canvas.** A chat gets a spatial surface beside its thread:
  `chat_canvas_pages` (migration 0033, RLS 0034), a `placement` discriminator on
  `chat_widgets` plus a page and a clamped grid box, and `chat_view_state` — the
  page THIS person has open, per viewer, persisted, and unreadable to anyone
  else. The canvas renders as an arrangeable grid on a desktop pane and as one
  column with swipeable pages on a phone, both INSIDE the chat
  ([`rigging/widgets/zine.md`](../../rigging/widgets/zine.md)). `chat_widget`
  gains `place`, `stack`, `new_page` and `rename_page`; the turn context tells
  an agent which page each human is looking at, and that it may not move one.
  `npm run chat -- page new|list|rename|rm` and `widget place|stack` are the
  human/debug doors.
- **#cse3 — The widget catalog moves to rigging.** Per-kind parsing and
  rendering leave `widgets.ts` and `chat.tsx` for the rigging catalog
  ([`rigging/widgets/zine.md`](../../rigging/widgets/zine.md)); the hull keeps
  only the row's structural answer contract (`offeredAnswer`). Two new kinds
  land — `note` and the live `issue-list`, which composes the issues service's
  data off its existing door and topic with no hull coupling. `chat_widget`
  becomes `kind` + `props` and generates its own kind list from the catalog,
  injected at `src/boot.ts` (`widget-catalog.ts`). The chat view stops knowing
  any kind by name; the thread finally scrolls to the newest message, and the
  composer placeholder stops advising "Enter to send" to a thumb.
- **#cse2 — The agent speaks for itself.** The orchestrator stops lifting
  assistant text out of a finished turn (`assistantTextFrom` is gone, and chat
  no longer imports `toChatItems`) and becomes pure dispatch. Two session tools
  — `chat_post` and `chat_widget` (`session-tools.ts`) — are registered on a
  chat's backing session through the runtime's new `sessionTools` seam, and run
  under the agent's own actor, so the agent decides what to say, can say it
  mid-turn, and can raise the widget slice #cse1 gave it no door for.
  `turnContext` was rewritten to teach it (an agent that isn't told goes
  silent). `chat_members.last_seen_message_id` (migration 0032) makes a silent
  turn survivable; the watermark resolves as max(column, the agent's own last
  post) so neither crash ordering doubles a reply or re-feeds forever. The
  progress line narrows to "this agent is mid-turn" and reads as a status, and
  silence shows a `Seen by @tilde` receipt instead of an auto-posted filler. The
  fake session now calls the tool too, so a fake-runtime ship isn't mute.
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
