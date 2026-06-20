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
  (e.g. `agent.message`), a `source` (the emitting service), a `scope`
  (visibility key), an optional `actorId` (who caused it — a `users.id`), and a
  jsonb `payload`.
- **Scope** — the visibility key. A subscriber sees an event only if its scope
  is one they subscribed to — e.g. `session:<id>` for one conversation, or
  `public`. The same rule (`isScopeVisible`) gates both the live fan-out and the
  replay.
- **Emit** (`emitEvent`) — the durable write: append the row, then
  `pg_notify('ship_log', …)`. The notify body is **tiny** — only
  `{id,type,scope}` — because Postgres caps a notification near 8KB; the full
  event lives in the row, read back by id.
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
  read one by id, list a scope's events since a cursor. Touches only `events`.
- **The SSE endpoint** (`src/routes/api/stream.ts`) — a server route returning a
  `text/event-stream`. On connect it replays everything past `Last-Event-ID` for
  the requested scopes, then forwards live events whose scope is visible.
- **The client hook** (`useShipLog`, in rigging) — opens an `EventSource`, calls
  back per matching event. This is what **replaces polling**.

## Structure

**A round trip.** A service calls `emitEvent(db, …)` → a row lands in `events`
and a tiny `{id,type,scope}` goes out on the `ship_log` channel → the web
server's one `LISTEN` connection wakes, publishes to the in-process bus → each
open SSE stream whose scope matches reads the full row by id and frames it to
its browser → the browser's `EventSource` fires, the `useShipLog` callback runs.

**Reconnect loses nothing.** The id is the cursor. On reconnect the browser
sends `Last-Event-ID` (the last id it saw); the route replays `events` with
`id > lastSeen` for the subscribed scopes straight from the table, then resumes
the live feed. To make "loses nothing" literally true the route does two things:
it **subscribes to the live bus before running the replay** (buffering, then
flushing deduped by id) so an event landing in the gap between query and go-live
isn't dropped; and it **pages the replay** — `listEventsSince` caps each call at
`REPLAY_PAGE_SIZE`, so the route loops, advancing the cursor, until a short page
comes back. A long absence drains fully; the cap only bounds one round-trip,
never the catch-up.

**Pure core, thin impure shell.** The wire format (`sse.ts`), the scope rule,
and the persistence (`service.ts`) are pure and unit-tested on PGlite — even
`pg_notify` runs there. The `LISTEN` connection and the `EventSource`
construction are the only genuinely live wiring, marked `v8 ignore` like the
agent runtime's Claude wiring.

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
- **NOTIFY carries only `{id,type,scope}`; the payload lives in the row.**
  Postgres caps a notification near 8KB, and a payload can be anything. The
  subscriber reads the full row by id, so the doorbell stays tiny by
  construction.
- **One dedicated LISTEN connection, separate from the shared query `db`.** A
  connection holding a `LISTEN` is occupied by the subscription and can't also
  serve queries, so the bus opens its own. Sending a NOTIFY needs no dedicated
  socket — it's a plain statement on `db`.
- **A subscriber sees exactly the scopes it asks for — and per-scope
  authorization is a known, loud debt.** The SSE route requires an authenticated
  actor before opening a stream (it calls `currentActor()` first), but it does
  **not** yet check that the actor is _entitled_ to a given `session:<id>` scope
  — it grants whatever `topics` are requested. While the ship is single-tenant
  (one crew) that's contained, but it's a real leak surface the moment a second
  human is aboard: any authenticated caller could replay another session's
  transcript by naming its scope. The entitlement check lands with the
  crew-filter primitive — see [`../users/zine.md`](../users/zine.md). Stated
  here so the deferral is as honest as the crew-filter's own.
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
- **#1** — The ship's log: a durable `events` table, `emitEvent` (row +
  pg_notify), a single LISTEN connection fanning out to SSE clients, the
  `/api/stream` endpoint with `Last-Event-ID` replay, and the `useShipLog` hook
  that retires polling. The agent service is its first emitter (message and
  status events scoped per session).
