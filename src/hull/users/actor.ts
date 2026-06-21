import { getCookie } from '@tanstack/react-start/server'

import { type Database, db, withActor } from '@hull/db/client'

import { getUserByHandle, getUserById, resolveActorHandle } from './service'
import type { UserRow } from './schema'

/**
 * The thin impure edge that answers "who is acting right now?". The rule it
 * follows is pure and unit-tested (resolveActorHandle in service.ts); here we
 * only read the ambient inputs — a cookie on the web, environment variables in
 * the CLI — and turn the resolved handle (or explicit id) into a user row.
 *
 * - **Web** (`currentActor()`): a dev cookie override (`skylark_actor`, naming a
 *   known handle, for testing as different humans) wins, else the configured
 *   operator (`SKYLARK_OPERATOR`, default "drufball").
 * - **CLI** (`cliActor()`): an explicit `SKYLARK_ACTOR=<userId>` wins outright —
 *   that's how an agent process declares its own identity — otherwise it falls
 *   back to the operator handle, the same default the web uses.
 */

/** Cookie that overrides the web actor for testing as a different human. */
export const ACTOR_COOKIE = 'skylark_actor'

/** The ship's operator handle: env override, default "drufball". */
export function operatorHandle(): string {
  return process.env.SKYLARK_OPERATOR ?? 'drufball'
}

/* v8 ignore start -- impure edge: reads request cookies / process env, exercised via the doors */
/** Resolve the acting user for a web request. Throws if the handle is unknown. */
export async function currentActor(): Promise<UserRow> {
  const cookieHandle = getCookie(ACTOR_COOKIE)
  const handle = resolveActorHandle({
    context: 'web',
    cookieHandle,
    operator: operatorHandle(),
  })
  const user = await getUserByHandle(db, handle)
  if (!user)
    throw new Error(`Unknown actor handle: ${handle} (is the crew seeded?)`)
  return user
}

/**
 * Resolve the acting user for a CLI/agent process. An explicit SKYLARK_ACTOR
 * userId wins; otherwise the operator handle. Returns undefined if neither
 * resolves to a known row — the caller decides whether that's fatal.
 */
export async function cliActor(): Promise<UserRow | undefined> {
  const explicitId = process.env.SKYLARK_ACTOR
  if (explicitId) return getUserById(db, explicitId)
  const handle = resolveActorHandle({
    context: 'cli',
    cookieHandle: undefined,
    operator: operatorHandle(),
  })
  return getUserByHandle(db, handle)
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
/* v8 ignore stop */
