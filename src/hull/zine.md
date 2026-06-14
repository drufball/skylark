# The Hull

_hull zine — issue #1_

## tl;dr

The hull is the load-bearing foundation — the planks every ship shares. Things
here are depended on widely and aren't meant to be customized. Today the hull
holds the database connection, the health service, and the agent — the ship's
first resident.

## Components

- **db client** — the single shared Postgres connection, `db`, exported from
  `db/client.ts`. Every service in every deck uses it.
- **health service** (`health/`) — the ship's pulse: reports whether the
  database answers.
- **agent service** (`agent/`) — the ship's first resident: durable
  conversations with Claude over the pi.dev SDK, with Postgres as the source of
  truth. See [`agent/zine.md`](agent/zine.md).
- **errors util** (`lib/errors.ts`) — `errorMessage()`, the one place that
  renders an unknown thrown value as a string. Importable downward by every
  deck.
- **crew primitive** — the access invariant "every row knows its crew": crew
  columns plus a query helper that won't compile without a crew filter. _(Not
  yet implemented. The agent service is the first to ship tables, and it does so
  single-tenant — a knowingly temporary debt, tracked in its zine — so the crew
  primitive now lands as its own piece of work rather than riding in for free.)_

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

- **#2** — the agent service ([`agent/zine.md`](agent/zine.md)) and a shared
  `errors` util. The agent is the first hull component with its own tables; it
  ships single-tenant, ahead of the crew primitive.
- **#1** — db connection and the health service. The crew primitive is designed
  but not yet built.
