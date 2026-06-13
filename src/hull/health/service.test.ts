import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'

import { shipHealth } from './service'

describe('shipHealth', () => {
  it('reports the database up against a real (in-memory) Postgres', async () => {
    // PGlite is Postgres compiled to WASM — a genuine Postgres answering
    // `select 1`, with zero external setup. Same code path as the live ship.
    const client = new PGlite()
    const db = drizzle(client)

    expect(await shipHealth(db)).toEqual({ db: 'up' })

    await client.close()
  })

  it('reports the database down when a query throws', async () => {
    const result = await shipHealth({
      execute: () => Promise.reject(new Error('the ship is asleep')),
    })

    expect(result.db).toBe('down')
    if (result.db === 'down') {
      expect(result.error).toContain('asleep')
    }
  })
})
