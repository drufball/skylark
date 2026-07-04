# Notifications

_notifications zine — issue #2_

## tl;dr

Every user — human or agent — has an **inbox** fed by **watches**. A watch says
"tell me when something happens on `<topic>`"; a reactor on the ship's log turns
watched events into inbox rows. Humans read theirs on the Inbox surface. For an
agent, a notification is a **wake-up**: the chat orchestrator runs a turn on the
agent's own inbox session, briefed on everything unread, and the agent decides
for itself which chat (if any) to post an update to — which is what closes the
planning loop (chat agent files issues → builder works them → the agent is woken
to review, update the right conversation, and file the next piece).

## Components

- **`notifications`** — one row per (user, source event); the
  `(user_id, event_id)` unique key makes fan-out idempotent. RLS scopes rows to
  their owner; only the system reactor inserts.
- **`watches`** — one row per (user, topic): durable intent to hear about a
  topic.
- **The reactor** (`service.ts` / `live.ts`) — a `ShipLogReactor` on systemDb
  that turns durable events into inbox rows for the topic's watchers.
- **The waker** (`hull/chat/waker.ts`) — the agent delivery: turns an agent's
  unread notifications into one wake turn on its own inbox session, leaving the
  chat-finding judgment to the agent. Its mechanics live in the
  [chat zine](../chat/zine.md).
- **Doors** — `myInbox`, `markInboxRead`, `watchState`, `setWatch`; all run
  under the current actor so RLS is the gate.

## Structure

**Fan-out, end to end.** A durable public event lands on the ship's log → the
reactor reads the full row and applies the auto-watch rules — the event's
**actor** is subscribed to auto-watch topics (issues; acting is caring, so
creators, commenters, and status-movers all watch through one rule), and an
`issue.opened` event also subscribes its **`ownerId`** (someone an issue is
filed FOR hears about it without ever acting) → every watcher except the actor
gets an inbox row → each row is announced on the owner's private
`notify:<userId>` topic (the topic IS the entitlement) and handed to the
delivery hooks. Guards: ephemeral events don't notify, the reactor's own
announcements never re-fan-out, and non-public events never fan out. On boot,
`reconcile` does two things: it replays **every** public event on the durable
log (not just issues — `topicPatterns: ['*']`) to recover watches, and it
re-delivers every unread notification through the hooks, so a reload never
strands an already-durable row unshown.

**A wake, end to end.** A delivery hook hands an agent's notification to the
waker → a debounce gathers the flurry into the whole unread backlog → **one wake
per agent**: a briefing turn driven through the chat orchestrator on the agent's
own inbox session (not any particular chat), which the agent uses to find the
right conversation itself and post an update, or do nothing. Consumption follows
delivery: a batch is marked read only **after** its wake succeeds, so a failed
wake leaves the rows unread and the next notification retries the backlog. Every
batch wakes — there is no "no route home" case anymore; routing is the agent's
own judgment, not the queue's.

## Decisions

- **One mechanism for humans and agents.** The queue doesn't know about wakes;
  delivery beyond the inbox is a hook the chat orchestrator registers.
- **Your own action is never your own news.**
- **Fan-out is idempotent by key**, not by discipline — replays and second
  processes are safe by construction.
- **Watches are durable intent; notifications are best-effort amplification.**
  Reconcile recovers the former, never backfills the latter (old news would
  flood late watchers; the thing itself still shows its state).
- **Auto-watch is scoped to issue topics** for now — chat has its own surface
  and would drown the inbox.
- **Handoffs bend the watch list, in both directions.** An `issue.owner_ping` is
  delivered to the owner even if they never watched (an owner ping must always
  land); an `issue.handoff` baton pass to an agent is NEVER delivered to that
  agent (the issues orchestrator is already driving it a turn — an inbox wake on
  top would double-drive it). Watchers other than the target hear both kinds.
  Both event types live in the [issues zine](../issues/zine.md).

## Changelog

- **Decouple issues from chat** — A wake now always fires (no more "no route
  home" orphan case): it lands on the agent's own inbox session, and the agent
  finds the chat to update itself via the new chat CLI.
- **Housekeeping** — fixed doc drift: `reconcile` was documented as recovering
  watches only from issue events, but it also scans every public topic and
  re-delivers unread notifications; `issue.handoff`/`toOwner` language updated
  to the post-#103 `issue.owner_ping` event type.
- **#2** — Owner-aware delivery: owners auto-watch on `issue.opened`; handoffs
  target the owner or exclude the baton target.
- **#1** — Inbox + watches + the fan-out reactor, the `notify:` visibility
  grammar, the Inbox surface, and the agent waker.
