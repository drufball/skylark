# The DB Foundation

_db zine — issue #1_

## tl;dr

The hull's database foundation: how every service reaches Postgres, and how the
crew invariant ("a resource is visible only to who it belongs to") is enforced
where it can't be forgotten — in the database itself, with Row-Level Security.
The design is **fail-closed by construction**: the app's base connection is a
non-superuser whose queries RLS filters by default, so a path that forgets to
say who's acting sees _nothing_, not everything.

## Components

- **`db`** (`client.ts`) — the shared handle every service and door uses.
  Connects as the non-superuser **`app_user`** (migration 0009), so RLS applies
  to every query. No aggregated schema attached — services pass their own tables
  — which keeps the hull free of upward imports.
- **`systemDb`** (`client.ts`) — the superuser handle for FIXED system plumbing
  that legitimately needs every row: the agent runtime (persists transcripts),
  the orchestrators' reconcile/reply (scan + act across chats), the
  notifications reactor (writes inbox rows across users), and seeding. It
  bypasses RLS, so it is never handed to a door or an LLM-driven path.
- **`withActor`** (`client.ts`) / **`runAsActor`** (`with-actor.ts`) — run a
  unit of work AS a crew member: a transaction that does
  `set local role app_user` and sets the `app.actor` GUC (both LOCAL, so nothing
  leaks across a pooled connection), then hands the callback the
  transaction-scoped db. Doors wrap their work in it (via the users service's
  `withCurrentActor`/`withCliActor`); the services they call stay oblivious to
  access.
- **`Database`** (`with-actor.ts`) — the type service logic accepts: satisfied
  by the live `db`, a `withActor` transaction, and the in-memory PGlite client
  tests use.
- **URL resolution** (`url.ts`) — one resolver every entry point shares:
  `resolveDatabaseUrl()` (superuser: `DATABASE_URL`) and `resolveAppUrl()`
  (`APP_DATABASE_URL`, else the superuser URL with the `app_user` credential).
- **Policies** — in migrations: 0007 (the `app_user` role + chat membership
  policies), 0008 (agent-session visibility by origin), 0015 (issue-session link
  inserts), 0009 (`app_user` becomes a login role and the app moves onto it).

## Structure

Two connections, two roles. Request and agent paths run `db` → `withActor` →
RLS-filtered queries; fixed plumbing runs `systemDb` and bypasses RLS
consciously. `client.ts` imports `with-actor.ts` and `url.ts`, one way; every
service imports `@hull/db/client`. In tests, PGlite connects as its superuser
and `runAsActor`'s role switch is what makes the policies bite.

## Decisions

- **Fail closed, by construction — not by remembering.** The base connection IS
  `app_user`, so a door that forgets `withActor` sets no actor GUC → the
  membership checks match a NULL actor → no rows come back. Forgetting the
  wrapper can't leak; it can only under-show.
- **`systemDb` never reaches a door.** Anything serving a request or running an
  agent's instructions must not touch the RLS-bypassing handle — that's the "ask
  the agent to read it for you" gap. An ESLint `no-restricted-imports` ban on
  importing `systemDb` holds the line everywhere, with a conscious per-file
  allowlist in `eslint.config.js` (the runtime, the orchestrator live shells,
  the notifications reactor, the agent CLI); joining the allowlist is a visible
  diff, i.e. a design review.
- **Keep a `withActor` unit SHORT.** It holds a transaction open; never wrap a
  long-lived stream in one call. The SSE route wraps each individual db touch
  instead.
- **Credentials can rotate without a migration.** `APP_DATABASE_URL` overrides
  the app connection wholesale for a deployment with rotated `app_user`
  credentials; the default reuses the superuser URL with the `app_user`/
  `app_user` credential from migration 0009.
- **Smoke runs can't touch your data.** With `SKYLARK_FAKE_RUNTIME` set, both
  resolvers force the connection onto the dedicated `skylark_smoke` database
  (`url.ts`) — same server, never the base db — so a smoke test booting the REAL
  server is isolated even if `DATABASE_URL` points at your dev data.

## Changelog

- **#1** — First issue: the two-handle split (`db` as `app_user` + `systemDb`),
  `withActor`/`runAsActor`, the ESLint systemDb ban, URL resolution with
  rotation + smoke isolation. (The mechanics predate the zine; written down as
  of the RLS enforcement landing.)
