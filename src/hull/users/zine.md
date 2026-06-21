# The Crew

_users zine — issue #2_

## tl;dr

The crew is the people aboard — the identity the whole system is scoped to.
Everyone who does anything on the ship is a **user**: you and your friends
(humans), and the ship's residents (agents — tilde, bix, dot). Every actor that
acts — sends a message, emits an event — resolves to a row here, and `actorId`
columns elsewhere point back at it.

The crew primitive landed in parts: first the data model and **actor
resolution** — given a request or a CLI process, who is acting? — and now the
**access enforcement** that the original primitive promised. Skylark is
single-crew (everyone in `users` is the crew), so access is intra-crew: a
resource is either public or visible to a specific set of users. We enforce that
with **Postgres Row-Level Security** rather than a compile-time helper — the
rule lives in the database, where (once the app connects as a non-superuser) a
forgotten filter can't leak rows. `withActor` (hull/db) runs a request as a crew
member: the non-superuser `app_user` role plus an `app.actor` GUC, and the
policies filter to what that actor may see. Chat's policies land first, proven
at the service layer; the doors and SSE stream adopt `withActor` to make
enforcement live in the app, then issues (public) and agent sessions (by origin)
follow.

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

- **Enforcement is Postgres RLS, not a compile-time helper.** The original plan
  named a "compile-time crew-filter helper"; we landed on **Row-Level Security**
  instead. Reasons: it lives in the database (the lowest layer — a service that
  forgets to filter still can't leak), it keeps membership **normalized**
  (policies join to `chat_members`; no per-row ACL to denormalize and re-sync),
  and the same probe gates the event stream that table reads can't cover. The
  cost is real and accepted: the app connects as the non-superuser `app_user`
  (migration 0009), and a separate superuser `systemDb` handle serves the few
  fixed system paths that need all rows (migrations, the agent runtime, the
  orchestrators' reconcile). Because the base connection is `app_user`, a door
  that forgets `withActor` sees **nothing** (NULL actor → the policy matches no
  rows) — fail-closed by construction, not by every door remembering.
- **`withActor` is the one place identity meets the database.** A door resolves
  who's acting and wraps its work in `withActor`; the services it calls receive
  a transaction-scoped db and stay oblivious to access. Kept short by design —
  never wrap a long-lived stream in one call (it holds a transaction open); the
  SSE route wraps each db touch instead.
- **The agent's single-tenant debt is being discharged.** The debt
  ([`../agent/zine.md`](../agent/zine.md)) waited on exactly this enforcement;
  chat lands first, agent sessions follow (visible by where they came from — an
  issue's session is public, a chat's follows membership).
- **Identity is ambient, resolved per context.** The web reads a cookie over the
  operator; the CLI reads an explicit `SKYLARK_ACTOR` over the operator. A
  cookie is a browser concept and is ignored in CLI context, so a stray cookie
  can never change who a CLI process acts as.
- **`profileId` stays a plain nullable column — wired, but no FK.** It now
  references real agent profiles (agents default to the `chat` profile via
  `assignDefaultAgentProfile`), but the column stays loose on purpose: the
  profiles live in the agent service, and a FK would force `users/schema.ts` to
  import the agent schema — which imports `users/schema.ts` for its own
  `agentUserId` FK — a circular module import. So users only ever writes its own
  column (the agent service's seed passes the id in); enforcement of the link
  stays out of the schema by design, not by omission.
- **A user is a human or an agent, in one table.** Agents act on the ship the
  same way people do — they emit events, they'll own work — so they're crew, not
  a separate kind of thing. `type` distinguishes them where it matters.

## Changelog

- **#3** — Access enforcement lands as Postgres RLS, discharging the deferred
  crew-filter promise. `withActor`/`runAsActor` (hull/db) run a request as a
  crew member via the `app_user` role + an `app.actor` GUC; migration 0007 adds
  the role and chat's membership policies (a chat, its roster, and its messages
  are visible/writable only to members, enforced in the database). The chat
  service is proven against it (`chat/access.test.ts`); the doors + SSE stream
  adopt `withActor` next, then issues (public) and agent sessions (by origin).
- **#2** — `profileId` wired to real agent profiles: `setUserProfile` and
  `assignDefaultAgentProfile` (idempotent; agents → the `chat` profile, humans
  untouched), called from the agent service's seed. The column stays FK-free to
  avoid a circular schema import — see Decisions.
- **#1** — The crew primitive, partially: the `users` table (human/agent), pure
  service logic, an idempotent `seedCrew` (operator + tilde/bix/dot), actor
  resolution (`currentActor`/`cliActor` over a pure `resolveActorHandle`), and
  CLI + web doors. The compile-time crew-filter enforcement is explicitly
  deferred.
