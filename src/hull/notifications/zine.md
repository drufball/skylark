# Notifications

_notifications zine — issue #1_

## tl;dr

Every user — human or agent — has an **inbox** fed by **watches**. A watch says
"tell me when something happens on `<topic>`"; a reactor on the ship's log turns
watched events into inbox rows. Humans read theirs on the Inbox surface. For an
agent, a notification is a **wake-up**: the chat orchestrator runs a turn in the
chat the work was filed from, briefed on everything unread — which is what
closes the planning loop (chat agent files issues → builder works them → the
agent is woken to review and file the next piece).

## Components

- **`notifications`** — one row per (user, source event); the
  `(user_id, event_id)` unique key makes fan-out idempotent under replays and
  multiple processes. RLS scopes rows to their owner; only the system reactor
  inserts.
- **`watches`** — one row per (user, topic). Earned two ways: the Watch button,
  and by **acting** — the reactor auto-subscribes an event's actor to auto-watch
  topics (issues). Acting is caring: creators, commenters, and status-movers all
  watch through the same rule.
- **The reactor** — a `ShipLogReactor` on systemDb: reads each durable event,
  applies the auto-watch, writes an inbox row per other watcher, and announces
  each on the owner's private `notify:<userId>` topic (the visibility gate
  admits only the owner — the topic IS the entitlement). Guards: ephemeral
  events don't notify, its own announcements never re-fan-out, and non-public
  events never fan out. Reconcile replays the durable issue events to recover
  auto-WATCHES only — missed notifications stay missed by design (old news would
  flood late watchers; the thing itself still shows its state).
- **The waker** (`hull/chat/waker.ts`) — the agent delivery: debounces a flurry
  into ONE wake per agent, resolves each notification's chat via the issue's
  `originChatId` (recorded when an agent files with `--chat`), marks the batch
  read (the briefing is the delivery), and drives the chat orchestrator's `wake`
  — a normal turn whose prompt is the briefing.
- **Doors** — `myInbox`, `markInboxRead`, `watchState`, `setWatch`; all run
  under the current actor so RLS is the gate.

## Decisions

- **One mechanism for humans and agents.** The queue doesn't know about wakes;
  delivery beyond the inbox is a hook the chat orchestrator registers.
- **Your own action is never your own news.**
- **Fan-out is idempotent by key**, not by discipline — replays and second
  processes are safe by construction.
- **Watches are durable intent; notifications are best-effort amplification.**
  Reconcile recovers the former, never backfills the latter.
- **Auto-watch is scoped to issue topics** for now — chat has its own surface
  and would drown the inbox.

## Changelog

- **#1** — Inbox + watches + the fan-out reactor, the `notify:` visibility
  grammar, the Inbox surface and thread Watch toggle, and the agent waker
  closing the planning loop via `issues.originChatId`.
