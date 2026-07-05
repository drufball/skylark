# Real Accounts

_auth zine — issue #1_

## tl;dr

Passwords and browser sessions for the crew's humans. Before this, the web UI
trusted an unsigned `skylark_actor` cookie naming any handle — fine while
Skylark lived on one person's laptop, not once it's a home server reachable by
more than one person. `auth` adds a real login: a password per human, a
signed-nothing-but-hashed session per browser, and a signup flow gated by an
invite secret so the operator controls who gets an account.

This is the one place identity gets ESTABLISHED, so it necessarily runs before
an actor (and the RLS context that comes with one) exists — see Decisions.

## Components

- **Credentials** (`schema.ts`) — one row per human with a password: `userId`
  (the primary key — one credential per user), a scrypt `passwordHash`. Agents
  never get one.
- **Sessions** (`schema.ts`) — one row per logged-in browser: `id`, `userId`, a
  `tokenHash` (the raw token lives only in the cookie — see Decisions),
  `createdAt`, `expiresAt` (a fixed 30-day TTL, no sliding renewal yet).
- **Password hashing** (`service.ts`) — `hashPassword`/`verifyPassword`, Node's
  own `scrypt` (`node:crypto`) — no dependency to pull in.
  `<salt-hex>:<hash-hex>`, constant-time compared.
- **Sessions** (`service.ts`) — `createSession`, `getSessionUser` (resolves a
  raw token to its user, undefined if unknown/expired), `deleteSession`.
- **Signup** (`service.ts`) — `signup(db, input, expectedInviteCode)`: the one
  business rule with real branches (invite code, handle validity, password
  length, claim-vs-create) — see Decisions for what each guards.
- **`setPassword`** (`service.ts`) — set/overwrite a password with no invite
  code check, for the CLI recovery door.
- **Doors** — `server.ts` (`currentSession`, `login`, `signup`, `logout` — web,
  via `createServerFn`) and `cli.ts` (`reset-password` — the recovery door when
  you're locked out, run from a shell you already trust).
- **The web edge** — `users/actor.ts`'s `currentActor()`/`getCurrentUser()` read
  the `skylark_session` cookie and delegate to `getSessionUser` here; see
  [`../users/zine.md`](../users/zine.md) for the full actor-resolution picture
  (web sessions vs. CLI's `SKYLARK_ACTOR`/operator, which this service doesn't
  touch).

## Structure

`auth` depends on `users` (a credential/session references `users.id`; signup
calls `createUser`/`getUserByHandle`/`validateHandle`) — not the other way. The
one exception is `users/actor.ts`, which imports `auth/service.ts` for the
session lookup itself, so identity resolution has one home (`users/actor.ts`)
even though the mechanics live here.

The root route's `beforeLoad` calls the `currentSession` door and redirects to
`/login` when it's empty; that's UX only. The real enforcement is
`currentActor()` itself — every web door already runs through
`withCurrentActor`, so making that function resolve a real session (instead of
trusting a cookie-named handle) closes the gap for every door and the SSE stream
at once, with no per-door changes.

## Decisions

- **credentials/sessions are RLS-enabled with NO policies** (migration 0022) —
  not even the owning user can read their own row through `db` + `withActor`.
  Deliberate: resolving "who is this?" has to happen BEFORE an actor (and so an
  RLS context) exists, so these tables are reachable only through `systemDb`
  (`server.ts`, `cli.ts`, `users/actor.ts` — see the `eslint.config.js`
  allowlist), the same category as seeding. A door that mistakenly imported `db`
  here sees and changes nothing, rather than leaking a password hash.
- **Sessions are stateful, not JWTs.** A raw random token in the cookie hashes
  to a row in `sessions`; the alternative (a self-contained signed token) can't
  be revoked without reintroducing a server-side denylist — which is the same
  state, with extra steps. Skylark is one Postgres, one server: the lookup costs
  nothing a stateless token would meaningfully save, and this way logout is a
  real delete.
- **Only the token's hash is ever stored.** Mirrors why passwords are hashed — a
  database leak shouldn't hand out live sessions, only unusable hashes.
- **scrypt via `node:crypto`, not a dependency.** Skylark's dependency list is
  short on purpose; Node's built-in scrypt is a standard, adequate choice for
  this scale and needed nothing new in `package.json`.
- **Signup claims an existing passwordless human row by handle, when one
  exists** — rather than always minting a new user. `seedCrew` already creates a
  human row for `SKYLARK_OPERATOR` (default `captain`) with no credentials;
  without claiming, the very first real signup (the operator giving themselves a
  password) would collide with that row's handle and either fail or fork their
  identity from whatever already points at that user id. Claiming keeps one
  operator = one id, seeded or not.
- **No email, no forgot-password flow.** A two-person home server doesn't need
  one; `npm run auth -- reset-password <handle> <password>` is the recovery
  path, using the shell access you'd already need for any other server-side fix.

## Changelog

- **#1** — Real accounts land: credentials + sessions, invite-gated signup,
  login/logout, the RLS lockdown (migration 0022), and `currentActor()` rewired
  onto sessions in place of the `skylark_actor` dev cookie.
