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
  (e.g. `captain`), a `displayName`, a `type` (`human` | `agent`), and — for
  agents — the columns that tell the runtime how its sessions boot
  (`systemPrompt`, `tools`, `readContextFiles`, `useRepoSkills`, `extensionIds`,
  `model`; null/schema-default and irrelevant for humans — see
  [`../agent/zine.md`](../agent/zine.md)).
- **Service logic** (`service.ts`) — pure, database-agnostic: create a user,
  read by id or handle, list the crew, update/delete an agent, `seedCrew`, and
  `handleOf` — the one home for "an id becomes a display handle, or `?`".
  Touches only `users`.
- **Seed crew** (`seedCrew(db, operator)`) — idempotently ensures the standard
  crew exists: the operator (a human — configurable via `SKYLARK_OPERATOR`,
  default `captain`, passed in as `operatorSeed()` from the impure edges) plus
  the six standard agents: `tilde`, `bix`, `dot`, `builder`, `hand`,
  `babysitter`. Inserts what's missing, never clobbers an existing row.
- **Actor resolution** — the impure edge, `actor.ts`:
  - `currentActor()` (web): a real, revocable session — see
    [`../auth/zine.md`](../auth/zine.md) for how login/signup/sessions work.
    Throws if there's no valid session; `getCurrentUser()` is the non-throwing
    twin the root route's `beforeLoad` uses to redirect to `/login`.
  - `cliActor()` (CLI/agent): an explicit `SKYLARK_ACTOR=<userId>` wins — how an
    agent process declares its own identity — else the operator handle
    (`SKYLARK_OPERATOR`, default `captain`). Unrelated to web sessions.
- **The door preamble** — `withCurrentActor` / `withCliActor` (`actor.ts`):
  resolve who's acting, open a `withActor` transaction, and hand the callback
  the RLS-scoped db + the actor row. The single sink for the resolve-then-scope
  preamble every door shares, so a door is one line and can't pass the wrong id.
- **Doors** — `cli.ts` (`seed`, `list`, `whoami`; run via `npm run users`) and
  `server.ts` (`listCrew`, `createAgentUser`, `updateAgentUser` — the last two
  manage named agents, seeding the agent's memory folder on create and rolling
  the row back if the seed fails).

## Structure

**Resolution reads ambient input and turns it into a row.** On the web that's a
session cookie, resolved against real sessions (`hull/auth`); on the CLI it's
`process.env`, resolved with the pure, unit-tested `cliActorOn`. `actor.ts` is
the one file that does this reading, so the decision-shaped logic underneath it
(auth's session/credential rules, `cliActorOn`) stays testable and the I/O is a
couple of lines at the boundary.

**Seeding is idempotent by handle.** `seedCrew` checks each standard handle and
inserts only the missing ones, so it's safe on a fresh database or an
established one, any number of times — and a hand-edited `displayName` or id
survives a re-seed. It runs from two places: the orchestrator's boot
(`ensureOrchestrator` converges crew + agent config + playbooks) and the
explicit `npm run users seed`.

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
- **Identity is ambient, resolved per context.** The web reads a real session
  (`hull/auth`); the CLI reads an explicit `SKYLARK_ACTOR` over the operator
  fallback. The two are unrelated — a browser session can never change who a CLI
  process acts as, and vice versa.
- **Agent config lives on the row it configures, not behind a pointer.** A crew
  this size doesn't need reusable templates, so there's no separate profile
  table and no FK-avoidance dance: `users/schema.ts` carries its own config
  columns directly, `hull/agent`'s `seedAgentConfig` writes them through the
  users service's own functions, and `agent/schema.ts` still only imports
  `users/schema.ts` one-way for `agentUserId`. This retired an older FK-free
  `profileId` column that existed solely to avoid the two schemas importing each
  other.
- **A user is a human or an agent, in one table.** Agents act on the ship the
  same way people do — they emit events, they own work — so they're crew, not a
  separate kind of thing. `type` distinguishes them where it matters.

## Changelog

- **Real login replaces the dev cookie.** `currentActor()` now resolves a real,
  revocable session (see [`../auth/zine.md`](../auth/zine.md)) instead of
  trusting a `skylark_actor` cookie naming any handle. `resolveActorHandle` (the
  web-vs-cli rule) is gone — the CLI path (`cliActorOn`) never needed it once
  the web branch moved to sessions.
- **Agent config folds onto `users`.** `profileId` is gone; every agent-config
  field lives directly on the agent's own row (see
  [`../agent/zine.md`](../agent/zine.md)). `setUserProfile`,
  `clearDanglingProfiles`, and `assignDefaultAgentProfile` retire with it.
- **#3** — Access enforcement lands as Postgres RLS: `withActor` + the
  `app_user` role, chat's membership policies (migration 0007), agent sessions
  and issue links following (0008, 0015).
- **#2** — `profileId` wired to real agent profiles via `setUserProfile` /
  `assignDefaultAgentProfile` (FK-free to avoid a circular schema import).
- **#1** — The crew primitive's data half: the `users` table, pure service
  logic, idempotent `seedCrew`, actor resolution, CLI + web doors.
