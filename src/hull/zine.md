# The Hull

_hull zine — issue #1_

## tl;dr

The hull is the load-bearing foundation — the planks every ship shares. Things
here are depended on widely and aren't meant to be customized. Today the hull
holds the database connection and the health service.

## Components

- **db client** — the single shared Postgres connection, `db`, exported from
  `db/client.ts`. Every service in every deck uses it.
- **health service** (`health/`) — the ship's pulse: reports whether the database
  answers.
- **crew primitive** — the access invariant "every row knows its crew": crew
  columns plus a query helper that won't compile without a crew filter. _(Not yet
  implemented — it lands with the first service that has tables.)_

## Structure

`db/client.ts` creates one connection and exports `db`. Services elsewhere import
it and query their own tables: `db.select().from(yourTable)`. The connection
carries no aggregated schema — services pass their own tables — which keeps the
hull from ever importing upward into rigging or home. The schema barrel that
drizzle-kit reads lives up in `src/schema.ts`.

## Decisions

- **One shared connection, with no schema attached.** Services pass their own
  tables; this keeps the hull free of upward imports.
- **The crew invariant is enforced in the hull.** When tables arrive, crew-scoping
  lives here — a security invariant is the most load-bearing thing on the ship.

## Changelog

- **#1** — db connection and the health service. The crew primitive is designed
  but not yet built.
