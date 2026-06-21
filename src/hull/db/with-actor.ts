import { sql } from 'drizzle-orm'

import type { Database } from './client'

// Run a unit of work AS a specific crew member, so Postgres Row-Level Security
// filters every query to what that actor may see (see migrations/0007). This is
// the one place identity meets the database: a door resolves who's acting, wraps
// its work in here, and the services it calls stay oblivious — they just run
// queries on the handle they're given, and RLS does the rest.
//
// Mechanism: a transaction that drops to the non-superuser `app_user` role and
// sets the `app.actor` GUC, both LOCAL so they're scoped to this transaction and
// can never leak across a pooled connection. The `set local role` is what makes
// the policies apply at all, because the live `db` connects as the superuser,
// which BYPASSES RLS.
//
// FAIL MODE, honestly: because the base connection is the superuser, a door that
// forgets `withActor` fails OPEN today (it reads as superuser and RLS is
// bypassed) — so the "a forgotten filter can't leak" guarantee is currently by
// convention (wrap every door), not by construction. The load-bearing follow-up
// that makes it truly fail-closed is to make the app's normal connection a
// NON-superuser (app_user), with a separate superuser handle for the few paths
// that need all rows (migrations, seed, the orchestrator's reconcile). Then
// `withActor` only sets the actor GUC, and forgetting it sees a NULL actor →
// the membership check matches nothing → no rows. Tracked, not done here.
//
// Keep the wrapped unit SHORT — never wrap a long-lived stream in one call, or
// you hold a transaction open for the life of the connection. The SSE route
// wraps each individual db touch instead.

/** The non-superuser role the app acts as; RLS policies are written against it. */
export const APP_ROLE = 'app_user'

/**
 * Run `fn` as `actorId`: open a transaction, switch to `app_user`, set the
 * `app.actor` GUC, and hand `fn` the transaction-scoped db. Every query `fn`
 * runs (directly or through a service) is RLS-filtered to that actor. Nesting a
 * service's own `db.transaction` inside works — it becomes a savepoint that
 * inherits the role + GUC.
 */
export async function runAsActor<T>(
  database: Database,
  actorId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    // The role is a constant identifier (can't be a bind param); the actor id
    // is parameterized so it's never interpolated into SQL.
    await tx.execute(sql`set local role ${sql.raw(APP_ROLE)}`)
    await tx.execute(sql`select set_config('app.actor', ${actorId}, true)`)
    return fn(tx)
  })
}
