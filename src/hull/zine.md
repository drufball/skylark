# The Hull

_hull zine — issue #6_

## tl;dr

The hull is the load-bearing foundation — the planks every ship shares. Things
here are depended on widely and aren't meant to be customized. Today the hull
holds the database foundation (two connection handles + Row-Level Security), the
health service, the agent (the ship's first resident), the ship's log (a durable
event bus), the crew (the users every action is attributed to), the issues board
(and its building agents), chat (the ship's front door), shared files,
notifications, the local-model bring-up, and the access gate that says who may
see what.

## Components

- **db foundation** (`db/`) — two Postgres handles from `db/client.ts`: `db`,
  the shared connection every service and door uses (connects as the
  non-superuser `app_user`, so RLS filters every query), and `systemDb`, the
  superuser handle reserved for fixed system plumbing and never handed to a
  door. `withActor` is how a door runs work as a crew member. See
  [`db/zine.md`](db/zine.md).
- **health service** (`health/`) — the ship's pulse: reports whether the
  database answers.
- **agent service** (`agent/`) — the ship's first resident: durable
  conversations with Claude over the pi.dev SDK, with Postgres as the source of
  truth. See [`agent/zine.md`](agent/zine.md).
- **events service** (`events/`) — the ship's log: a durable event bus where
  every service emits and anything subscribes. Postgres rows are the truth;
  NOTIFY is the doorbell; SSE delivers to browsers. See
  [`events/zine.md`](events/zine.md).
- **users service** (`users/`) — the crew: the people and agents aboard, and the
  actor resolution that says who's acting. See [`users/zine.md`](users/zine.md).
- **issues service** (`issues/`) — the message board and the building agents: an
  issue lifecycle (open→building→done/closed) plus the event-driven orchestrator
  that turns a transition into a worktree + builder session and drives it to a
  merged PR. See [`issues/zine.md`](issues/zine.md).
- **chat service** (`chat/`) — the ship's front door: conversations between crew
  (humans and agents), where membership is visibility and an agent member's
  replies are driven through its backing session. See
  [`chat/zine.md`](chat/zine.md).
- **files service** (`files/`) — the crew's shared documents: real files in the
  repo, staged on a git branch and auto-merged back. See
  [`files/zine.md`](files/zine.md).
- **notifications service** (`notifications/`) — every user's inbox, fed by
  watches on ship-log topics; for an agent, a notification is a wake-up. See
  [`notifications/zine.md`](notifications/zine.md).
- **local-model service** (`local-model/`) — the hardware-fitted Ollama
  bring-up: detect what the machine can run, pick and pull a model, and the
  Models surface.
- **access gate** (`access/`) — `canSeeTopic` (`access/visibility.ts`), the one
  entitlement gate for "may this actor see X?". It probes the parent resource
  under the actor's RLS context, so the policies stay the single source of
  truth; the SSE stream and the in-process control doors all ask it.
- **errors util** (`lib/errors.ts`) — `errorMessage()`, the one place that
  renders an unknown thrown value as a string. Importable downward by every
  deck.
- **crew primitive** — the access invariant: a resource is visible only to the
  crew it belongs to. Skylark is single-crew, so access is intra-crew (public,
  or a specific set of users). Enforced with **Postgres Row-Level Security**:
  the app's base connection is `app_user`, and `withActor` (`db/client.ts`) runs
  a request as a crew member with an `app.actor` GUC, so policies filter every
  query in the database itself. A door that forgets `withActor` sees **nothing**
  — fail-closed by construction. Policies are live for chat (migration 0007),
  agent sessions (0008), and issue-session links (0015); the data model + actor
  resolution live in the users service (see [`users/zine.md`](users/zine.md)).

## Structure

`db/client.ts` creates the connections and exports `db` (and `systemDb` for
fixed plumbing). Services elsewhere import `db` and query their own tables:
`db.select().from(yourTable)`. The connection carries no aggregated schema —
services pass their own tables — which keeps the hull from ever importing upward
into rigging or home. (drizzle-kit finds tables on its own by globbing every
`src/**/schema.ts`.)

## Decisions

- **Two handles, no schema attached.** `db` is RLS-scoped `app_user`; `systemDb`
  is the superuser for fixed system plumbing (the agent runtime, the
  orchestrators' reconcile, seeding) and is never handed to a door or an
  LLM-driven path — an ESLint import ban with a conscious allowlist holds that
  line (see [`db/zine.md`](db/zine.md)). Services pass their own tables
  (`db.select().from(t)`); this keeps the hull free of upward imports. The cost,
  by design: Drizzle's relational API (`db.query.*`) is unavailable — use the
  query builder.
- **The crew invariant is enforced in the hull.** Crew-scoping lives here — in
  the database roles, `withActor`, and the RLS policies — because a security
  invariant is the most load-bearing thing on the ship.
- **"Decoupled" means: no other service's tables.** A service reads and writes
  only its own; it learns about the rest through an exported function or the
  ship's log. Two named exceptions, held by `src/architecture.test.ts`: joining
  `users` for identity (every row knows its crew — that IS the design), and
  declared FKs between schemas (issues → agent, issues → chat, chat → agent)
  from the owning `schema.ts` only. A new exception is a diff on that test —
  which makes it a design review, not a drift.

## Changelog

- **#6** — Files, notifications, and local-model join the hull; RLS enforcement
  goes live everywhere (two db handles, `withActor`, the `canSeeTopic` gate in
  `access/`), discharging the agent service's single-tenant debt.
- **#5** — The chat service ([`chat/zine.md`](chat/zine.md)): the ship's front
  door becomes chat with the crew.
- **#4** — The issues service ([`issues/zine.md`](issues/zine.md)): the message
  board, the building agents, and the first cross-process ship-log reactor.
- **#3** — The ship's log ([`events/zine.md`](events/zine.md)) and the crew
  ([`users/zine.md`](users/zine.md)).
- **#2** — The agent service ([`agent/zine.md`](agent/zine.md)) and a shared
  `errors` util.
- **#1** — db connection and the health service.
