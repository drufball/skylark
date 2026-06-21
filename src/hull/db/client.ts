import { type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { runAsActor } from './with-actor'
import { resolveDatabaseUrl } from './url'

// The connection target — DATABASE_URL, the local default, or (in smoke/test
// mode) the dedicated skylark_smoke db. See url.ts for the one-place rule.
const connectionString = resolveDatabaseUrl()

// One shared connection for the whole ship. postgres-js connects lazily — on
// the first query, not at import — so importing this never throws when Postgres
// is asleep.
const client = postgres(connectionString, { max: 10 })

// The shared database handle every service uses: `db.select().from(yourTable)`.
// No aggregated schema is attached here on purpose — services pass their own
// tables explicitly, which keeps the hull from ever needing to import upward
// into rigging/home. (drizzle-kit finds tables by globbing src/**/schema.ts.)
export const db: PostgresJsDatabase = drizzle(client)

// The database type service logic should accept. The live `db` above and the
// in-memory PGlite client used in tests both satisfy it, and it exposes the full
// query builder (`.select().from(...)`). Typing a service's db parameter as this
// is what keeps the service driver-agnostic and testable against PGlite.
export type Database = PgDatabase<PgQueryResultHKT>

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
