# The Crew

_users zine — issue #3_

## tl;dr

The crew is the people aboard — the identity the whole system is scoped to.
Everyone who does anything on the ship is a **user**: you and your friends
(humans), and the ship's residents (agents). Every actor that acts — sends a
message, emits an event — resolves to a row here, and `actorId` columns
elsewhere point back at it.

The crew primitive has two halves, both live: the data model + **actor
resolution** — given a request or a CLI process, who is acting? — and **access
enforcement**. Skylark is single-crew (everyone in `users` is the crew), so
access is intra-crew: a resource is either public or visible to a specific set
of users. That's enforced with **Postgres Row-Level Security** in the db
foundation: `withActor` runs a request as a crew member, and the policies filter
to what that actor may see (see [`../db/zine.md`](../db/zine.md)). Policies
cover chat (membership), agent sessions (by origin), and issue-session links.

## Components

- **User** — someone aboard: a row in `users`. A UUIDv7 `id`, a unique `handle`
  (e.g. `captain`), a `displayName`, a `type` (`human` | `agent`), and a
  nullable `profileId` pointing at an agent profile (a plain column, no FK — see
  Decisions).
- **Service logic** (`service.ts`) — pure, database-agnostic: create a user,
  read by id or handle, list the crew, update/delete an agent, `seedCrew`, and
  `handleOf` — the one home for "an id becomes a display handle, or `?`".
  Touches only `users`.
- **Seed crew** (`seedCrew(db, operator)`) — idempotently ensures the standard
  crew exists: the operator (a human — configurable via `SKYLARK_OPERATOR`,
  default `captain`, passed in as `operatorSeed()` from the impure edges) plus
  the six standard agents: `tilde`, `bix`, `dot`, `builder`, `hand`,
  `babysitter`. Inserts what's missing, never clobbers an existing row.
- **Actor resolution** — the rule (`resolveActorHandle`, pure) plus the edge
  (`actor.ts`, impure):
  - `currentActor()` (web): a dev cookie override (`skylark_actor`, naming a
    known handle — for testing as different humans) ?? the configured operator
    (`SKYLARK_OPERATOR`, default `captain`), resolved to a row.
  - `cliActor()` (CLI/agent): an explicit `SKYLARK_ACTOR=<userId>` wins — how an
    agent process declares its own identity — else the operator handle.
- **The door preamble** — `withCurrentActor` / `withCliActor` (`actor.ts`):
  resolve who's acting, open a `withActor` transaction, and hand the callback
  the RLS-scoped db + the actor row. The single sink for the resolve-then-scope
  preamble every door shares, so a door is one line and can't pass the wrong id.
- **Doors** — `cli.ts` (`seed`, `list`, `whoami`; run via `npm run users`) and
  `server.ts` (`listCrew`, `createAgentUser`, `updateAgentUser` — the last two
  manage named agents, seeding the agent's memory folder on create and rolling
  the row back if the seed fails).

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
survives a re-seed. It runs from two places: the orchestrator's boot
(`ensureOrchestrator` converges crew + profiles + playbooks) and the explicit
`npm run users seed`.

## Decisions

- **Enforcement is Postgres RLS, not a compile-time helper.** The original plan
  named a "compile-time crew-filter helper"; we landed on **Row-Level Security**
  instead. Reasons: it lives in the database (the lowest layer — a service that
  forgets to filter still can't leak), it keeps membership **normalized**
  (policies join to `chat_members`; no per-row ACL to denormalize and re-sync),
  and the same probe gates the event stream that table reads can't cover. The
  mechanics — roles, `withActor`, fail-closed, the `systemDb` exception — live
  in [`../db/zine.md`](../db/zine.md).
- **Nothing personal is nailed into the hull.** The operator is the ship's own
  configuration (`SKYLARK_OPERATOR`), not a hardcoded handle; `seedCrew` takes
  the operator as input and only the standard agents are constants.
- **Identity is ambient, resolved per context.** The web reads a cookie over the
  operator; the CLI reads an explicit `SKYLARK_ACTOR` over the operator. A
  cookie is a browser concept and is ignored in CLI context, so a stray cookie
  can never change who a CLI process acts as.
- **`profileId` stays a plain nullable column — wired, but no FK.** It
  references real agent profiles (agents default to the `chat` profile via
  `assignDefaultAgentProfile`), but the column stays loose on purpose: the
  profiles live in the agent service, and a FK would force `users/schema.ts` to
  import the agent schema — which imports `users/schema.ts` for its own
  `agentUserId` FK — a circular module import. So users only ever writes its own
  column (the agent service's seed passes the id in); enforcement of the link
  stays out of the schema by design, not by omission.
- **A user is a human or an agent, in one table.** Agents act on the ship the
  same way people do — they emit events, they own work — so they're crew, not a
  separate kind of thing. `type` distinguishes them where it matters.

## Changelog

- **#3** — Access enforcement lands as Postgres RLS: `withActor` + the
  `app_user` role, chat's membership policies (migration 0007), agent sessions
  and issue links following (0008, 0015).
- **#2** — `profileId` wired to real agent profiles via `setUserProfile` /
  `assignDefaultAgentProfile` (FK-free to avoid a circular schema import).
- **#1** — The crew primitive's data half: the `users` table, pure service
  logic, idempotent `seedCrew`, actor resolution, CLI + web doors.
