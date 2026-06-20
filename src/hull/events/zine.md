# The Ship's Log

_events zine — issue #1_

## tl;dr

The ship's log is a **durable** event bus, with a narrow ephemeral path for
transient UI. Every service emits to it; anything can subscribe. Most events are
rows in Postgres — a durable source of truth that replays on reconnect and
crosses process boundaries. A small class (chat progress, status ticks) use the
ephemeral `notifyOnly` path: they reach live subscribers in this process but
aren't persisted, never replay, and never cross to other processes. The default
is durable; ephemeral is a deliberate opt-in for UI that would clutter the log.

Two halves make that work. **Postgres NOTIFY** is the doorbell — a tiny "event
`X` happened in scope `Y`" announcement that crosses process boundaries
instantly. The **events table** is the truth — the full payload, and the cursor
a reconnecting client replays from. The web server holds one dedicated `LISTEN`
connection, fans each notification out to its connected browsers over SSE, and
the browser's `EventSource` echoes the last id it saw so the replay is
automatic.

## Components

- **Event** — one thing that happened: a row in `events`. Its `id` is a UUIDv7,
  so it's time-ordered and doubles as the stream cursor. It carries a `type`
  (e.g. `agent.message`), a `source` (the emitting service), a `topic` (entity
  stream like `issue:123`), an `audience` (access level: `public` or `members`),
  an optional `actorId` (who caused it — a `users.id`), and a jsonb `payload`.
- **Topic** — the entity stream this event belongs to (e.g., `issue:123`,
  `chat:456`, `session:s1`). Subscribers express interest via **patterns** like
  `issue:*` (all issues) or `chat:123` (one chat), and `matchesTopic()` does
  wildcard matching.
- **Audience** — who may see this event. `public` = everyone; `members` = crew
  members only. Access hierarchy: members ⊇ public (members can see both).
  `canViewAudience()` enforces this.
- **Emit** (`emitEvent`) — the durable write: append the row, then
  `pg_notify('ship_log', …)`. The notify body is **tiny** — only
  `{id,type,topic,audience}` — because Postgres caps a notification near 8KB;
  the full event lives in the row, read back by id.
- **Notify-only** (`notifyOnly`) — the ephemeral path: publish to the in-process
  bus (so live SSE subscribers receive it) without persisting a row. For
  transient UI — chat agent progress, status-line ticks — that shouldn't clutter
  the log or replay on reconnect. In-process only: no `pg_notify`, so other
  processes never see it.
- **The bus** (`bus.ts`) — the impure shell. One process-wide `InProcessBus` (a
  subscriber set) plus the single dedicated `LISTEN ship_log` connection that
  feeds it. A throwing subscriber is isolated so one broken stream can't starve
  the rest.
- **Service logic** (`service.ts`) — pure, database-agnostic: append an event,
  read one by id, list events matching topic patterns and audience since a
  cursor. Touches only `events`.
- **The SSE endpoint** (`src/routes/api/stream.ts`) — a server route returning a
  `text/event-stream`. On connect it replays everything past `Last-Event-ID` for
  the requested topic patterns (with audience filtering), then forwards live
  events (durable and ephemeral) whose topic matches and audience is accessible.
- **The client hook** (`useShipLog`, in rigging) — opens an `EventSource`, calls
  back per matching event. This is what **replaces polling**.

## Structure

**A round trip.** A service calls `emitEvent(db, …)` → a row lands in `events`
and a tiny `{id,type,topic,audience}` goes out on the `ship_log` channel → the
web server's one `LISTEN` connection wakes, publishes to the in-process bus →
each open SSE stream whose topic patterns match (and whose viewer's access level
permits the audience) reads the full row by id and frames it to its browser →
the browser's `EventSource` fires, the `useShipLog` callback runs.

**One event, one row.** An issue status change emits **once** with
`topic='issue:<id>'` and `audience='public'`. The board subscribes to `issue:*`
(all issues); the thread subscribes to `issue:<id>` (one issue). Both patterns
match the same row — no dual-emit, no deduplication. Separating topic (entity
stream) from audience (access control) is standard pub/sub architecture (NATS
subjects, AMQP topic exchanges, Redis PSUBSCRIBE): publish once, subscribe by
pattern, authorize separately.

**Reconnect loses nothing.** The id is the cursor. On reconnect the browser
sends `Last-Event-ID` (the last id it saw); the route replays `events` with
`id > lastSeen` for the subscribed topic patterns (filtered by audience)
straight from the table, then resumes the live feed (including ephemeral
events). To make "loses nothing" literally true the route does two things: it
**subscribes to the live bus before running the replay** (buffering, then
flushing deduped by id) so an event landing in the gap between query and go-live
isn't dropped; and it **pages the replay** — `listEventsSince` caps each call at
`REPLAY_PAGE_SIZE`, so the route loops, advancing the cursor, until a short page
comes back. A long absence drains fully; the cap only bounds one round-trip,
never the catch-up. Ephemeral events are never replayed (they're transient UI),
so a reconnect after missing them sees only durable state.

**Pure core, thin impure shell.** The wire format (`sse.ts`), the topic pattern
matching, the audience access logic, and the persistence (`service.ts`) are pure
and unit-tested on PGlite — even `pg_notify` runs there. The `LISTEN` connection
and the `EventSource` construction are the only genuinely live wiring, marked
`v8 ignore` like the agent runtime's Claude wiring.

## Decisions

- **The log is durable by default; ephemeral is a narrow opt-in.** Most events
  are rows; NOTIFY is the doorbell. This is why a reconnect replays, why a crash
  loses nothing, and why the CLI's emits reach the web server. The ephemeral
  path (`notifyOnly`) is deliberately constrained: in-process only (no
  `pg_notify`), never replayed, for the small class of transient UI (progress
  placeholders, heartbeats) that would clutter the log if persisted. The
  **decision rule**: if a reconnecting client should see the event, or another
  process should hear it, or you'd want it in a transcript dump → durable. If
  it's live-only UI scaffolding that goes stale the moment it renders →
  ephemeral.
- **NOTIFY carries only `{id,type,topic,audience}` (or `scope` for old events);
  the payload lives in the row.** Postgres caps a notification near 8KB, and a
  payload can be anything. The subscriber reads the full row by id, so the
  doorbell stays tiny by construction.
- **One dedicated LISTEN connection, separate from the shared query `db`.** A
  connection holding a `LISTEN` is occupied by the subscription and can't also
  serve queries, so the bus opens its own. Sending a NOTIFY needs no dedicated
  socket — it's a plain statement on `db`.
- **Topic and audience are separate facets: stream identity vs. access
  control.** An event's topic (e.g., `issue:123`) says which entity stream it
  belongs to; its audience (`public` or `members`) says who may see it.
  Subscribers pattern-match on topics (`issue:*` for all issues) and are
  filtered by audience access. This retired the dual-emit pattern where issue
  events were emitted twice (once to `issue:<id>`, once to `public`) so both the
  thread and board SSE could see them — now one event, one row.
- **Audience enforcement is schema-only for now.** The `audience` column is
  written and `canViewAudience()` implements the access hierarchy (members ⊇
  public), but the SSE route currently treats all authenticated users as
  `members` (single-crew). Per-user entitlement — checking that a specific user
  may access a given topic — rides with the crew-filter primitive. See
  [`../users/zine.md`](../users/zine.md). Audience gates _what kind_ of events a
  viewer sees (public vs. members-only); the crew-filter will gate _which
  specific_ topics they're entitled to.
- **Agent events are unattributed for now (`actorId` is null).** The runtime
  emits without an actor because a turn is fired server-side without yet
  threading who initiated it. The column and FK exist so attribution can land
  without a migration; wiring the acting user through is crew-integration work,
  deferred deliberately rather than done half-way.
- **Emit can fail without breaking the work that emitted.** The durable state is
  already committed before the notify; callers (the agent runtime) treat
  emission as fire-and-forget so a sleepy log never stalls a turn.

## Changelog

- **#2** — Ephemeral notify-only path (`notifyOnly`) for transient UI: publishes
  to the in-process bus (live SSE delivery) without persisting a row or firing
  `pg_notify`. In-process only, never replayed. Chat orchestrator uses it for
  `agent_progress` events (the "working…" placeholder).
- **#kg42** — Separate topic from audience; retire dual-emit. Events now have
  `topic` (entity stream: `issue:123`, `chat:456`) and `audience` (access:
  `public` or `members`) as distinct fields. Subscribers express interest via
  topic **patterns** (`issue:*`, `chat:123`) matched by `matchesTopic()`; access
  is enforced separately via `canViewAudience()` (members ⊇ public). One logical
  event → one durable row. This retired the dual-emit pattern (issues emitted to
  both `issue:<id>` and `public`) and removed the scope-dedup workaround in the
  orchestrator. Migration 0005 adds the columns; the SSE route, board, and
  thread all use the new pattern-matching API.
- **#1** — The ship's log: a durable `events` table, `emitEvent` (row +
  pg_notify), a single LISTEN connection fanning out to SSE clients, the
  `/api/stream` endpoint with `Last-Event-ID` replay, and the `useShipLog` hook
  that retires polling. The agent service is its first emitter (message and
  status events scoped per session).
