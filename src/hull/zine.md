# The Hull

_hull zine — issue #2_

## tl;dr

The hull is the load-bearing foundation — the planks every ship shares. Things
here are depended on widely and aren't meant to be customized. Today the hull
holds the database connection, the health service, the agent (the ship's first
resident), the ship's log (a durable event bus), the crew (the users every
action is attributed to), the issues board (and its building agents), and chat
(the ship's front door).

## Components

- **db client** — the single shared Postgres connection, `db`, exported from
  `db/client.ts`. Every service in every deck uses it.
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
- **errors util** (`lib/errors.ts`) — `errorMessage()`, the one place that
  renders an unknown thrown value as a string. Importable downward by every
  deck.
- **crew primitive** — the access invariant "every row knows its crew": crew
  columns plus a query helper that won't compile without a crew filter. _(Lands
  in two parts. The data model and actor resolution exist now in the users
  service ([`users/zine.md`](users/zine.md)); the compile-time crew-filter
  enforcement is still deferred. The agent service ships single-tenant until
  that enforcement arrives — a knowingly temporary debt, tracked in its zine.)_

## Structure

`db/client.ts` creates one connection and exports `db`. Services elsewhere
import it and query their own tables: `db.select().from(yourTable)`. The
connection carries no aggregated schema — services pass their own tables — which
keeps the hull from ever importing upward into rigging or home. (drizzle-kit
finds tables on its own by globbing every `src/**/schema.ts`.)

## Decisions

- **One shared connection, with no schema attached.** Services pass their own
  tables (`db.select().from(t)`); this keeps the hull free of upward imports.
  The cost, by design: Drizzle's relational API (`db.query.*`) is unavailable —
  use the query builder.
- **The crew invariant is enforced in the hull.** When tables arrive,
  crew-scoping lives here — a security invariant is the most load-bearing thing
  on the ship.

## Changelog

- **#5** — the chat service ([`chat/zine.md`](chat/zine.md)): the ship's front
  door becomes chat with the crew. Membership is visibility; an agent member
  replies through a backing session the orchestrator drives, and only its text
  crosses into the clean transcript. The old agent session monitor moved to the
  Agents view.
- **#4** — the issues service ([`issues/zine.md`](issues/zine.md)): the ship's
  message board and the building agents. Its orchestrator is the first hull
  component that _reacts_ to the ship's log across processes — an agent's CLI
  transition in a separate process drives the worktree/builder lifecycle in the
  web server — so it's the proof the durable event bus earns its keep. A
  `builder` crew member joins the seed.
- **#3** — the ship's log ([`events/zine.md`](events/zine.md)) and the crew,
  partially ([`users/zine.md`](users/zine.md)). The events service makes
  "everything is an event" real and durable; the users service makes "who is
  acting" real. The crew-filter enforcement half of the crew primitive is still
  deferred.
- **#2** — the agent service ([`agent/zine.md`](agent/zine.md)) and a shared
  `errors` util. The agent is the first hull component with its own tables; it
  ships single-tenant, ahead of the crew primitive.
- **#1** — db connection and the health service. The crew primitive is designed
  but not yet built.
