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
// into rigging/home. The full schema is assembled in src/schema.ts, for
// migrations only.
export const db: PostgresJsDatabase = drizzle(client)
