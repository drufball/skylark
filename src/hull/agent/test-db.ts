import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import type { Database } from '@hull/db/client'

/**
 * A fresh in-memory Postgres (PGlite) with every migration applied — the same
 * SQL the live ship runs, so tests exercise the real schema. Returns the db and
 * a close() to tear it down. Test-only helper (not shipped in any door).
 */
export async function freshDb(): Promise<{
  db: Database
  close: () => Promise<void>
}> {
  const client = new PGlite()
  const db = drizzle(client)
  await migrate(db, { migrationsFolder: 'src/migrations' })
  return { db: db as unknown as Database, close: () => client.close() }
}

/** Narrow away null/undefined in tests without a forbidden `!`. */
export function defined<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value, got null/undefined')
  return value
}
