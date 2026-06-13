import { type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

/** Local default. Override with DATABASE_URL (see scripts/setup, .env). */
export const DEFAULT_DATABASE_URL =
  'postgres://postgres:postgres@localhost:5432/skylark'

const connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL

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
