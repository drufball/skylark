import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { type Database, runAsActor } from './with-actor'
import { resolveAppUrl, resolveDatabaseUrl } from './url'

// Two connections, two roles. The ship runs as the non-superuser `app_user`, so
// Row-Level Security applies to every query by default — a path that forgets
// `withActor` sees NOTHING, not everything (fail closed). The superuser is
// reserved for fixed system plumbing that legitimately needs every row
// (`systemDb`); nothing that serves a request or runs an agent's instructions
// touches it. postgres-js connects lazily, so importing this never throws when
// Postgres is asleep.

// The shared handle every service + door uses: RLS-scoped, as `app_user`.
const appClient = postgres(resolveAppUrl(), { max: 10 })

// The shared database handle every service uses: `db.select().from(yourTable)`.
// No aggregated schema is attached here on purpose — services pass their own
// tables explicitly, which keeps the hull from ever needing to import upward
// into rigging/home. (drizzle-kit finds tables by globbing src/**/schema.ts.)
export const db: PostgresJsDatabase = drizzle(appClient)

// The superuser handle for FIXED system plumbing only: the agent runtime
// (persists transcripts), the orchestrators' reconcile/reply (scan + act across
// chats), and seeding. It BYPASSES RLS, so it must never be handed to a door or
// an LLM-driven path — that's the "ask the agent to read it for you" gap. Lives
// here so the one-way rule (callers reach down to db/client) is preserved.
const systemClient = postgres(resolveDatabaseUrl(), { max: 5 })
export const systemDb: PostgresJsDatabase = drizzle(systemClient)

// The database type service logic should accept — defined next to runAsActor
// (see with-actor.ts), re-exported here because `@hull/db/client` is where
// every service already looks for it.
export type { Database } from './with-actor'

/**
 * Run a unit of work as a crew member, with Row-Level Security filtering every
 * query to what that actor may see. The web doors wrap their handlers in this;
 * the services they call receive the transaction-scoped db and stay oblivious to
 * access. Keep the unit short — see runAsActor for why a long-lived stream must
 * not be wrapped whole.
 */
export function withActor<T>(
  actorId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return runAsActor(db, actorId, fn)
}
