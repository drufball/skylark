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

/**
 * Apply every .sql migration whose numeric prefix sorts within [from, to].
 * Compares the `NNNN` prefix, not the full filename: a cutoff like '0012'
 * naming migration 0012 must include exactly that file. Comparing full
 * filenames against a bare cutoff would exclude it — '0012_foo.sql' > '0012'
 * lexically, since the cutoff is a proper prefix of the filename — silently
 * skipping the boundary migration on both sides of a range.
 */
async function applyRange(
  client: PGlite,
  range: { from?: string; to?: string },
): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    const prefix = file.split('_')[0]
    if (range.from && prefix < range.from) continue
    if (range.to && prefix > range.to) continue
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
    // Replays the whole migration chain on PGlite — slow on a loaded machine
    // (a mutation sweep saturating the cores pushed it past the default 5s).
  }, 30_000)

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
    // Replays the whole migration chain on PGlite — slow on a loaded machine
    // (a mutation sweep saturating the cores pushed it past the default 5s).
  }, 30_000)
})

describe('0018/0019 upgrade — agent profiles fold onto their users row', () => {
  it('carries a customized profile onto every user that pointed at it', async () => {
    const client = new PGlite()
    try {
      // The ship as it was: a hand-rolled profile with real customization,
      // and two crew members pointing at it — exactly what the live ship has.
      await applyRange(client, { to: '0016' })
      await client.exec(`
        insert into users (id, handle, display_name, type, profile_id)
          values ('u-builder', 'builder', 'Builder', 'agent', 'p-custom'),
                 ('u-hand', 'hand', 'Hand', 'agent', 'p-custom'),
                 ('u-dru', 'drufball', 'Dru', 'human', null);
        insert into agent_profiles
          (id, name, system_prompt, tools, read_context_files, use_repo_skills, extension_ids, model)
          values ('p-custom', 'my-builder', 'build it my way', '["read","bash"]'::jsonb,
                  true, true, '["ext-1"]'::jsonb, 'claude-opus-4-5');
      `)

      await applyRange(client, { from: '0017' })

      const rows = await client.query<{
        id: string
        system_prompt: string | null
        tools: string[] | null
        read_context_files: boolean
        use_repo_skills: boolean
        extension_ids: string[]
        model: string | null
      }>(
        `select id, system_prompt, tools, read_context_files, use_repo_skills, extension_ids, model
           from users where id in ('u-builder', 'u-hand') order by id`,
      )
      for (const row of rows.rows) {
        expect(row.system_prompt).toBe('build it my way')
        expect(row.tools).toEqual(['read', 'bash'])
        expect(row.read_context_files).toBe(true)
        expect(row.use_repo_skills).toBe(true)
        expect(row.extension_ids).toEqual(['ext-1'])
        expect(row.model).toBe('claude-opus-4-5')
      }

      // A human with no profile is left with the schema defaults, untouched.
      const dru = await client.query<{
        system_prompt: string | null
        read_context_files: boolean
        extension_ids: string[]
      }>(
        `select system_prompt, read_context_files, extension_ids from users where id = 'u-dru'`,
      )
      expect(dru.rows[0].system_prompt).toBeNull()
      expect(dru.rows[0].read_context_files).toBe(true)
      expect(dru.rows[0].extension_ids).toEqual([])

      // The profile table and the profile_id columns are gone.
      const tables = await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_name = 'agent_profiles'`,
      )
      expect(tables.rows).toEqual([])
      const columns = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
           where table_name = 'users' and column_name = 'profile_id'`,
      )
      expect(columns.rows).toEqual([])
    } finally {
      await client.close()
    }
  }, 30_000)

  it('leaves a user with no profile at the schema defaults', async () => {
    const client = new PGlite()
    try {
      await applyRange(client, { to: '0016' })
      await client.exec(`
        insert into users (id, handle, display_name, type)
          values ('u-tilde', 'tilde', 'Tilde', 'agent');
      `)

      await applyRange(client, { from: '0017' })

      const row = await client.query<{
        system_prompt: string | null
        tools: string[] | null
        read_context_files: boolean
        use_repo_skills: boolean
        extension_ids: string[]
        model: string | null
      }>(
        `select system_prompt, tools, read_context_files, use_repo_skills, extension_ids, model
           from users where id = 'u-tilde'`,
      )
      expect(row.rows[0]).toEqual({
        system_prompt: null,
        tools: null,
        read_context_files: true,
        use_repo_skills: true,
        extension_ids: [],
        model: null,
      })
    } finally {
      await client.close()
    }
  }, 30_000)
})
