import { getCookie } from '@tanstack/react-start/server'

import { getSessionUser, SESSION_COOKIE } from '@hull/auth/service'
import { type Database, db, systemDb, withActor } from '@hull/db/client'

import { getUserByHandle, getUserById } from './service'
import type { UserRow } from './schema'

/**
 * The thin impure edge that answers "who is acting right now?". Here we only
 * read the ambient inputs — a session cookie on the web, environment
 * variables in the CLI — and turn them into a user row.
 *
 * - **Web** (`currentActor()`): the `skylark_session` cookie, resolved against
 *   real sessions (auth/service.ts) — the session lookup runs on `systemDb`
 *   because there's no actor (and so no RLS context) until it resolves one.
 * - **CLI** (`cliActor()`): an explicit `SKYLARK_ACTOR=<userId>` wins outright —
 *   that's how an agent process declares its own identity — otherwise it falls
 *   back to the operator handle (`SKYLARK_OPERATOR`). Unrelated to web
 *   sessions: a stray browser cookie can never change who a CLI process acts as.
 */

/** The slice of the environment the actor rules read (process.env fits). */
export interface ActorEnv {
  SKYLARK_ACTOR?: string | undefined
  SKYLARK_OPERATOR?: string | undefined
}

/** The ship's operator handle: env override (SKYLARK_OPERATOR), neutral default. */
export function operatorHandle(env: ActorEnv = process.env): string {
  return env.SKYLARK_OPERATOR ?? 'captain'
}

/** The operator as a seed-crew row — what the impure edges hand to seedCrew. */
export function operatorSeed(): { handle: string; displayName: string } {
  const handle = operatorHandle()
  return {
    handle,
    displayName: handle.charAt(0).toUpperCase() + handle.slice(1),
  }
}

/**
 * The db- and env-parameterized rule behind cliActor, unit-tested directly:
 * an explicit SKYLARK_ACTOR userId wins outright (an unknown id resolves to
 * undefined, never a fallback — a mistyped agent identity must not quietly
 * become the operator); otherwise the operator handle is looked up. Returns
 * undefined when nothing resolves — the caller decides whether that's fatal.
 */
export async function cliActorOn(
  db: Database,
  env: ActorEnv,
): Promise<UserRow | undefined> {
  const explicitId = env.SKYLARK_ACTOR
  if (explicitId) return getUserById(db, explicitId)
  return getUserByHandle(db, operatorHandle(env))
}

/**
 * Fail closed: the resolved actor, or the seeding error every CLI door
 * shares. Split from withCliActor so the decision is unit-tested.
 */
export function requireActor(me: UserRow | undefined): UserRow {
  if (!me)
    throw new Error(
      'No actor resolved — seed the crew (`npm run users seed`) or set SKYLARK_ACTOR.',
    )
  return me
}

/* v8 ignore start -- impure edge: reads request cookies / the process env and
   module-level db, exercised via the doors. The rules these edges follow
   (cliActorOn, requireActor) are unit-tested above; auth/service.ts's
   getSessionUser is unit-tested there. */
/**
 * Resolve the logged-in user for a web request, or undefined if there isn't
 * one (no cookie, or an unknown/expired session) — never throws, so route
 * guards can use it to decide "redirect to /login" without a try/catch.
 */
export async function getCurrentUser(): Promise<UserRow | undefined> {
  const token = getCookie(SESSION_COOKIE)
  if (!token) return undefined
  return getSessionUser(systemDb, token)
}

/** Resolve the acting user for a web request. Throws if there's no valid session. */
export async function currentActor(): Promise<UserRow> {
  const user = await getCurrentUser()
  if (!user) throw new Error('Not authenticated')
  return user
}

/**
 * Resolve the acting user for a CLI/agent process. An explicit SKYLARK_ACTOR
 * userId wins; otherwise the operator handle. Returns undefined if neither
 * resolves to a known row — the caller decides whether that's fatal.
 */
export async function cliActor(): Promise<UserRow | undefined> {
  return cliActorOn(db, process.env)
}

/**
 * Run a web door's work as the current actor, under RLS. Resolves who's acting,
 * then opens a `withActor` transaction and hands the callback the
 * actor-scoped db + the actor row — so a door is one line and can't pass the
 * wrong id. The single sink for the `currentActor()` + `withActor` preamble
 * every RLS-scoped door shares. Lives here (not in db/client) so the db
 * foundation never imports the web request context — `users/actor → db/client`
 * stays one-way.
 */
export async function withCurrentActor<T>(
  fn: (db: Database, me: UserRow) => Promise<T>,
): Promise<T> {
  const me = await currentActor()
  return withActor(me.id, (tx) => fn(tx, me))
}

/**
 * The CLI counterpart to `withCurrentActor`: resolve who the CLI/agent process
 * is acting as (`cliActor()` — SKYLARK_ACTOR or the operator), then run the work
 * under that actor's RLS context, handing the callback the scoped db + actor
 * row. So a CLI command reads only what its identity may see (fail closed),
 * rather than leaning on a permissive policy. Throws if no actor resolves —
 * the same message the doors used to inline. Keep the unit short: never wrap a
 * long-lived runtime turn in this (see runAsActor); those run on `systemDb`.
 */
export async function withCliActor<T>(
  fn: (db: Database, me: UserRow) => Promise<T>,
): Promise<T> {
  const me = requireActor(await cliActor())
  return withActor(me.id, (tx) => fn(tx, me))
}
/* v8 ignore stop */
