# The Ship's Log

_events zine — issue #39_

## tl;dr

The ship's log is a **durable** event bus, with a narrow ephemeral path for
transient UI. Every service emits to it; anything can subscribe. Most events are
rows in Postgres — a durable source of truth that replays on reconnect and
crosses process boundaries. A narrow class (chat agent progress) uses the
ephemeral `notifyOnly` path: it reaches live subscribers in this process but
isn't persisted, never replays, and never crosses to other processes. The
default is durable; ephemeral is a deliberate opt-in for UI that would clutter
the log.

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
  transient UI — chat agent progress — that shouldn't clutter the log or replay
  on reconnect. In-process only: no `pg_notify`, so other processes never see
  it. An ephemeral note carries `topic` + `audience` exactly like a durable
  emit, so the SSE route gates it by the same topic-match + audience +
  entitlement rules — it can't slip past an access check just because it isn't
  persisted.
- **The bus** (`bus.ts`) — the impure shell. One process-wide `InProcessBus` (a
  subscriber set) plus the single dedicated `LISTEN ship_log` connection that
  feeds it. A throwing subscriber is isolated so one broken stream can't starve
  the rest.
- **Reactor** (`ShipLogReactor` + `subscribeToShipLog`, in `bus.ts`) — the
  contract for a service that reacts to the log: a `handleBusNote` per note and
  a `reconcile` for what a restart missed. `subscribeToShipLog` registers the
  subscription **synchronously** (no note is missed) and kicks `reconcile` in
  the **background** (recovery never gates the door that booted it). The chat
  orchestrator, the issues orchestrator, and the notifications reactor all wire
  in through it.
- **Service logic** (`service.ts`) — pure, database-agnostic: append an event,
  read one by id, list events matching topic patterns and audience since a
  cursor. Touches only `events`.
- **The stream coordinator** (`runShipLogStream`, in `replay-stream.ts`) — the
  pure-ish core of the SSE endpoint: the order-sensitive subscribe-before-replay
  → buffer → flush-deduped → go-live handshake, plus the topic/audience gate
  (`noteIsVisible`) and the ephemeral-inline-vs-durable-fetch decision. Driven
  through injected boundaries (`subscribe`, `listEventsSince`, `getEventById`,
  `send`) so it's unit-tested with a fake bus + fake DB — no socket, no
  Postgres.
- **The SSE endpoint** (`src/routes/api/stream.ts`) — a thin server route
  returning a `text/event-stream`. It resolves the actor, parses topics, and
  wires `runShipLogStream` to a `ReadableStream` controller; what remains is the
  genuinely impure shell (controller, encoder, heartbeat, abort + dead-socket
  teardown), `v8 ignore`d.
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
match the same row: publish once, subscribe by pattern, authorize separately.

**Reconnect loses nothing.** The id is the cursor. On reconnect the browser
sends `Last-Event-ID` (the last id it saw); `runShipLogStream` replays `events`
with `id > lastSeen` for the subscribed topic patterns (filtered by audience)
straight from the table, then resumes the live feed (including ephemeral
events). To make "loses nothing" literally true the coordinator does two things:
it **subscribes to the live bus before running the replay** (buffering, then
flushing deduped by id) so an event landing in the gap between query and go-live
isn't dropped; and it **pages the replay** — `listEventsSince` caps each call at
`REPLAY_PAGE_SIZE`, so it loops, advancing the cursor, until a short page comes
back. A long absence drains fully; the cap only bounds one round-trip, never the
catch-up. Ephemeral events are never replayed (they're transient UI), so a
reconnect after missing them sees only durable state.

**Pure core, thin impure shell.** The wire format (`sse.ts`), the topic pattern
matching + audience logic + persistence (`service.ts`), and the stream
coordination (`replay-stream.ts`) are pure and unit-tested on PGlite (or with
fakes) — even `pg_notify` runs there. The `LISTEN` connection, the
`ReadableStream` lifecycle in the route, and the `EventSource` construction are
the only genuinely live wiring, marked `v8 ignore` like the agent runtime's
Claude wiring.

## Decisions

- **Reactors recover via crash-only, not cooperative drain (#lo0x).** Server
  reloads are routine (HMR on merged code, the done-refresh, the files sweep)
  and frequent. The notification/session mechanics survive them via CRASH-ONLY
  recovery: (1) EAGER BOOT — arm all reactors at server start from a
  composition-root boot module (`src/boot.ts`), instead of lazily on first door
  use, so after every reload reconcile runs immediately and the deaf window is
  ~0; (2) ARM-ONCE without HMR cooperation — globalThis-keyed registry prevents
  duplicate subscriptions that survive module re-execution (SSR reload resets
  module state but globalThis persists), because `import.meta.hot.dispose` hooks
  do NOT fire for SSR module reloads (proven by #xwh2 residual: post-#91 forced
  reload delivered one message 3x). Crash-only means no cooperative 'prepare for
  reload' protocol to maintain — reloads are involuntary and the common case
  bypasses any drain path. Reconcile is the recovery; idempotent arm is the
  guard.
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
- **NOTIFY carries only `{id,type,topic,audience}`; the payload lives in the
  row.** Postgres caps a notification near 8KB, and a payload can be anything.
  The subscriber reads the full row by id, so the doorbell stays tiny by
  construction.
- **One dedicated LISTEN connection, separate from the shared query `db`.** A
  connection holding a `LISTEN` is occupied by the subscription and can't also
  serve queries, so the bus opens its own. Sending a NOTIFY needs no dedicated
  socket — it's a plain statement on `db`.
- **Topic and audience are separate facets: stream identity vs. access
  control.** An event's topic (e.g., `issue:123`) says which entity stream it
  belongs to; its audience (`public` or `members`) says who may see it.
  Subscribers pattern-match on topics (`issue:*` for all issues) and are
  filtered by audience access. One logical event → one durable row.
- **Audience is the coarse facet; per-topic entitlement is the real gate.** The
  `audience` column + `canViewAudience()` answer "what _kind_ of events may a
  member see" (public vs. members-only), and the SSE route treats every
  authenticated user as `members` (single-crew). That alone isn't enough — a
  member who isn't in a chat could still subscribe to its topic — so the route
  also gates every event through **`canSeeTopic`**
  ([`../access/visibility.ts`](../access/visibility.ts)): topic patterns say
  what the client _asked_ for, entitlement says what they're _allowed_. It
  **probes the parent under the actor's RLS context** — `chat:<id>` reads
  `chats` (0007), `session:<id>` reads `agent_sessions` (0008),
  `notify:<userId>` admits exactly that user (the topic IS the entitlement),
  `issue:*` is public — so the policies are the single source of truth, not a
  copy. This is the per-user entitlement the crew-filter promised, applied on
  the read path the durable tables can't cover (live + ephemeral events never
  hit an RLS-gated query). The gate is **memoised per topic for the life of the
  connection** — a busy chat doesn't re-probe per event — which leaves one known
  window: a member _removed_ from a chat keeps receiving its events until they
  reconnect. Accepted for now; the fix when it matters is a short TTL on the
  memo or invalidating the entry on a `chat.membership_changed` event over the
  bus.
- **Agent events are unattributed for now (`actorId` is null).** The runtime
  emits without an actor because a turn is fired server-side without yet
  threading who initiated it. The column and FK exist so attribution can land
  without a migration; wiring the acting user through is crew-integration work,
  deferred deliberately rather than done half-way.
- **Emit can fail without breaking the work that emitted.** The durable state is
  already committed before the notify; callers (the agent runtime) treat
  emission as fire-and-forget so a sleepy log never stalls a turn.

## Changelog

- **#39** — SSE stream coordination extracted into `replay-stream.ts`
  (`runShipLogStream` + `noteIsVisible`), unit-testable behind injected
  boundaries.
- **#kg43** — The legacy `scope` field retired (migration 0006); ephemeral notes
  gain `topic` + `audience` so the SSE route gates them like durable events; a
  bare SSE connection subscribes to nothing.
- **#2** — The ephemeral `notifyOnly` path lands, first used for chat
  `agent_progress`.
- **#kg42** — Topic and audience become distinct fields (migration 0005),
  retiring the dual-emit pattern (issues emitted to both `issue:<id>` and
  `public`).
- **#1** — The ship's log: the durable `events` table, `emitEvent`, the LISTEN
  fan-out, `/api/stream` with `Last-Event-ID` replay, and `useShipLog`.
