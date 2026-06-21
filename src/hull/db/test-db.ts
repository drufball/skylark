import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import type { Database } from '@hull/db/client'
import { runAsActor } from '@hull/db/with-actor'

/**
 * A fresh in-memory Postgres (PGlite) with every migration applied — the same
 * SQL the live ship runs, so tests exercise the real schema. Returns the db and
 * a close() to tear it down. Shared test-only harness for any service's tests.
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

/**
 * Run a query block as a crew member, under RLS — the test-side mirror of the
 * doors' `withActor`. Use it to prove a policy actually filters: a query outside
 * `asActor` runs as the PGlite superuser and bypasses RLS (handy for arranging
 * fixtures), so any test that asserts enforcement must go through here.
 */
export function asActor<T>(
  db: Database,
  actorId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return runAsActor(db, actorId, fn)
}

/** Narrow away null/undefined in tests without a forbidden `!`. */
export function defined<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value, got null/undefined')
  return value
}
