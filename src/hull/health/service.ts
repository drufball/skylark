import { sql, type SQL } from 'drizzle-orm'

import { errorMessage } from '@hull/lib/errors'

/** The minimal shape both the postgres-js and PGlite drizzle clients satisfy. */
export interface Queryable {
  execute: (query: SQL) => Promise<unknown>
}

export type ShipHealth = { db: 'up' } | { db: 'down'; error: string }

/**
 * The ship's pulse.
 *
 * Pure logic: hand it any drizzle database and it reports whether the database
 * answers. Driver-agnostic on purpose — the live postgres-js client (see
 * server.ts) and the in-memory PGlite client used in tests both flow through
 * this one path, so the test exercises the real thing.
 */
export async function shipHealth(database: Queryable): Promise<ShipHealth> {
  try {
    await database.execute(sql`select 1`)
    return { db: 'up' }
  } catch (error) {
    return { db: 'down', error: errorMessage(error) }
  }
}
