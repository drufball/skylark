# Notifications

_notifications zine — issue #2_

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
  `(user_id, event_id)` unique key makes fan-out idempotent. RLS scopes rows to
  their owner; only the system reactor inserts.
- **`watches`** — one row per (user, topic): durable intent to hear about a
  topic.
- **The reactor** (`service.ts` / `live.ts`) — a `ShipLogReactor` on systemDb
  that turns durable events into inbox rows for the topic's watchers.
- **The waker** (`hull/chat/waker.ts`) — the agent delivery: turns an agent's
  unread notifications into wake turns in the chats the work came from. Its
  mechanics live in the [chat zine](../chat/zine.md).
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
`reconcile` replays the durable issue events to recover **watches only**.

**A wake, end to end.** A delivery hook hands an agent's notification to the
waker → a debounce gathers the flurry, then the batch is grouped by the chat its
work belongs to (the issue's `originChatId`) → **one wake per (agent, origin
chat)**: a briefing turn driven through the chat orchestrator, whose reply lands
in that chat. Consumption follows delivery: a batch is marked read only
**after** its wake succeeds, so a failed wake leaves the rows unread and the
next notification retries the backlog; notifications with no route home (a topic
with no origin chat) are consumed without a wake — an agent's inbox has no other
reader.

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
- **Handoffs bend the watch list, in both directions.** An `issue.handoff` with
  `toOwner` is delivered to the owner even if they never watched (an owner ping
  must always land); a baton pass to an agent is NEVER delivered to that agent
  (the issues orchestrator is already driving it a turn — an inbox wake on top
  would double-drive it). Watchers other than the target hear both kinds. The
  handoff itself lives in the [issues zine](../issues/zine.md).

## Changelog

- **#2** — Owner-aware delivery: owners auto-watch on `issue.opened`; handoffs
  target the owner or exclude the baton target.
- **#1** — Inbox + watches + the fan-out reactor, the `notify:` visibility
  grammar, the Inbox surface, and the agent waker.
