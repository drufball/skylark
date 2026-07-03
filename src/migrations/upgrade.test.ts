import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

/**
 * The one migration path freshDb can't exercise: an UPGRADE. Every other test
 * applies all migrations to an empty database, so a backfill that mangles
 * pre-existing rows would pass CI and only fail on the live ship. This suite
 * replays history — apply migrations up to a cutoff, seed rows the way the old
 * code shaped them, then apply the rest and assert the data survived.
 */

const MIGRATIONS_DIR = 'src/migrations'

/** Apply every .sql migration whose filename sorts within [from, to]. */
async function applyRange(
  client: PGlite,
  range: { from?: string; to?: string },
): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    if (range.from && file < range.from) continue
    if (range.to && file > range.to) continue
    await client.exec(await readFile(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

describe('0013/0014 upgrade — the owner + issue_sessions backfill', () => {
  it('carries a live building issue across: owner backfilled, session link kept, still visible', async () => {
    const client = new PGlite()
    try {
      // The ship as it was: schema through 0012, one human, one builder agent,
      // and an in-flight building issue whose session hangs off
      // issues.session_id — exactly what the old orchestrator wrote.
      await applyRange(client, { to: '0012' })
      await client.exec(`
        insert into users (id, handle, display_name, type)
          values ('u-dru', 'drufball', 'Dru', 'human'),
                 ('u-builder', 'builder', 'Builder', 'agent');
        insert into agent_sessions (id, model, agent_user_id, status)
          values ('s-build', 'claude-sonnet-4-5', 'u-builder', 'idle');
        insert into issues (id, nano, title, status, author_id, session_id)
          values ('i-live', 'ab12', 'mid-flight build', 'building', 'u-dru', 's-build');
      `)

      await applyRange(client, { from: '0013' })

      // The owner backfill: existing issues are owned by their author.
      const owner = await client.query<{ owner_id: string }>(
        `select owner_id from issues where id = 'i-live'`,
      )
      expect(owner.rows[0].owner_id).toBe('u-dru')

      // The session link survived the column's retirement.
      const link = await client.query<{
        agent_user_id: string
        session_id: string
      }>(`select agent_user_id, session_id from issue_sessions`)
      expect(link.rows).toEqual([
        { agent_user_id: 'u-builder', session_id: 's-build' },
      ])

      // And the re-pointed RLS predicate still reads the session as
      // issue-owned (public), through the new table.
      const visible = await client.query<{ ok: boolean }>(
        `select app_can_see_session('s-build') as ok`,
      )
      expect(visible.rows[0].ok).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('leaves a legacy session with no agent identity behind, without failing the migration', async () => {
    const client = new PGlite()
    try {
      await applyRange(client, { to: '0012' })
      // A pre-profiles session: no agent_user_id. It has no (issue, agent) key,
      // so it can't be carried — the migration must skip it, not abort.
      await client.exec(`
        insert into users (id, handle, display_name, type)
          values ('u-dru', 'drufball', 'Dru', 'human');
        insert into agent_sessions (id, model, status)
          values ('s-old', 'claude-sonnet-4-5', 'idle');
        insert into issues (id, nano, title, status, author_id, session_id)
          values ('i-old', 'cd34', 'ancient build', 'building', 'u-dru', 's-old');
      `)

      await applyRange(client, { from: '0013' })

      const links = await client.query(`select * from issue_sessions`)
      expect(links.rows).toEqual([])
      // The orphaned session falls back to the bare-session arm: crew-visible.
      const visible = await client.query<{ ok: boolean }>(
        `select app_can_see_session('s-old') as ok`,
      )
      expect(visible.rows[0].ok).toBe(true)
    } finally {
      await client.close()
    }
  })
})
