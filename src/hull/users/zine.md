# The Crew

_users zine — issue #1_

## tl;dr

The crew is the people aboard — the identity the whole system is scoped to.
Everyone who does anything on the ship is a **user**: you and your friends
(humans), and the ship's residents (agents — tilde, bix, dot). Every actor that
acts — sends a message, emits an event — resolves to a row here, and `actorId`
columns elsewhere point back at it.

This is the crew primitive landing **partially**. We build the data model and
**actor resolution** — given a request or a CLI process, who is acting? — but
**not** the compile-time crew-filter helper (the "every row knows its crew, by
construction" enforcement promised in [`../zine.md`](../zine.md)). That
enforcement is the load-bearing security invariant and is deliberately still
ahead of us; this issue makes "who" a real, queryable thing so the rest of the
ship can start attributing actions to people.

## Components

- **User** — someone aboard: a row in `users`. A UUIDv7 `id`, a unique `handle`
  (e.g. `drufball`), a `displayName`, a `type` (`human` | `agent`), and a
  nullable `profileId` (a plain column now — it'll point at agent profiles in a
  later milestone, so there's no FK yet).
- **Service logic** (`service.ts`) — pure, database-agnostic: create a user,
  read by id or handle, list the crew, and `seedCrew`. Touches only `users`.
- **Seed crew** (`seedCrew`) — idempotently ensures the standard crew exists:
  the operator `@drufball` (human) plus `tilde`, `bix`, `dot` (agents). Inserts
  what's missing, never clobbers an existing row.
- **Actor resolution** — the rule (`resolveActorHandle`, pure) plus the edge
  (`actor.ts`, impure):
  - `currentActor()` (web): a dev cookie override (`skylark_actor`, naming a
    known handle — for testing as different humans) ?? the configured operator
    (`SKYLARK_OPERATOR`, default `drufball`), resolved to a row.
  - `cliActor()` (CLI/agent): an explicit `SKYLARK_ACTOR=<userId>` wins — how an
    agent process declares its own identity — else the operator handle.
- **Doors** — `cli.ts` (`seed`, `list`, `whoami`; run via `npm run users`) and
  `server.ts` (`whoAmI`, `listCrew`).

## Structure

**Resolution is a pure rule with a thin edge.** `resolveActorHandle` takes the
ambient inputs — context (web/cli), the cookie handle, the operator — and
returns the winning handle. That's unit-tested exhaustively. The only impure
part is reading those inputs: `getCookie` on the web, `process.env` in the CLI.
`actor.ts` does that reading and then turns the handle (or an explicit
`SKYLARK_ACTOR` id) into a row, so everything decision-shaped stays testable and
the I/O is a couple of lines at the boundary.

**Seeding is idempotent by handle.** `seedCrew` checks each standard handle and
inserts only the missing ones, so it's safe on a fresh database or an
established one, any number of times — and a hand-edited `displayName` or id
survives a re-seed. Run it from a migration's data step or `npm run users seed`.

## Decisions

- **The crew lands in two parts; this is part one.** Data model + actor
  resolution now; the compile-time crew-filter helper later. Stated plainly so
  the deferral is honest, not silent — the agent service already carries a known
  single-tenant debt ([`../agent/zine.md`](../agent/zine.md)) waiting on exactly
  that enforcement, and this issue does **not** discharge it.
- **Identity is ambient, resolved per context.** The web reads a cookie over the
  operator; the CLI reads an explicit `SKYLARK_ACTOR` over the operator. A
  cookie is a browser concept and is ignored in CLI context, so a stray cookie
  can never change who a CLI process acts as.
- **`profileId` is a plain nullable column, no FK yet.** It will reference agent
  profiles that don't exist on the ship yet; adding the constraint now would be
  a reference to nothing. The column reserves the shape; the FK lands with
  profiles.
- **A user is a human or an agent, in one table.** Agents act on the ship the
  same way people do — they emit events, they'll own work — so they're crew, not
  a separate kind of thing. `type` distinguishes them where it matters.

## Changelog

- **#1** — The crew primitive, partially: the `users` table (human/agent), pure
  service logic, an idempotent `seedCrew` (operator + tilde/bix/dot), actor
  resolution (`currentActor`/`cliActor` over a pure `resolveActorHandle`), and
  CLI + web doors. The compile-time crew-filter enforcement is explicitly
  deferred.
