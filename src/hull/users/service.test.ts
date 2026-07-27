import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'

import { users } from './schema'
import {
  createUser,
  getUserByHandle,
  getUserById,
  getUsersByIds,
  handleOf,
  listUsers,
  seedCrew,
  SEED_AGENTS,
  UNKNOWN_HANDLE,
  deleteUser,
  updateAgentUser,
  validateHandle,
} from './service'

describe('users service', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('handleOf resolves a handle, and falls back to ? for null or unknown', async () => {
    const u = await createUser(db, {
      id: 'h1',
      handle: 'kestrel',
      displayName: 'Kestrel',
      type: 'human',
    })
    expect(await handleOf(db, u.id)).toBe('kestrel')
    expect(await handleOf(db, null)).toBe(UNKNOWN_HANDLE)
    expect(await handleOf(db, 'no-such-id')).toBe(UNKNOWN_HANDLE)
  })

  it('creates a user and reads it back by id and handle', async () => {
    const user = await createUser(db, {
      id: 'u1',
      handle: 'drufball',
      displayName: 'Dru',
      type: 'human',
    })

    expect(user).toMatchObject({ handle: 'drufball', type: 'human' })
    expect(await getUserById(db, 'u1')).toMatchObject({ handle: 'drufball' })
    expect(await getUserByHandle(db, 'drufball')).toMatchObject({ id: 'u1' })
  })

  it('returns undefined for unknown id or handle', async () => {
    expect(await getUserById(db, 'nope')).toBeUndefined()
    expect(await getUserByHandle(db, 'nope')).toBeUndefined()
  })

  it('updates only the fields given, leaving the rest alone', async () => {
    await createUser(db, {
      id: 'u1',
      handle: 'scout',
      displayName: 'Scout',
      type: 'agent',
    })
    const renamed = await updateAgentUser(db, 'u1', {
      displayName: 'Scout Prime',
    })
    expect(renamed).toMatchObject({
      handle: 'scout',
      displayName: 'Scout Prime',
      systemPrompt: null,
    })
    const reconfigured = await updateAgentUser(db, 'u1', {
      systemPrompt: 'scout ahead',
      tools: ['read'],
    })
    expect(reconfigured).toMatchObject({
      displayName: 'Scout Prime',
      systemPrompt: 'scout ahead',
      tools: ['read'],
    })
  })

  it('updateAgentUser refuses humans and unknown users alike (not-found)', async () => {
    await createUser(db, {
      id: 'h1',
      handle: 'dru',
      displayName: 'Dru',
      type: 'human',
    })
    // A human row can never be renamed or handed a profile through this path.
    expect(
      await updateAgentUser(db, 'h1', { displayName: 'Hacked' }),
    ).toBeUndefined()
    expect((await getUserById(db, 'h1'))?.displayName).toBe('Dru')
    expect(
      await updateAgentUser(db, 'nope', { displayName: 'X' }),
    ).toBeUndefined()
  })

  it('deleteUser removes the row (the compensating delete)', async () => {
    await createUser(db, {
      id: 'u1',
      handle: 'scout',
      displayName: 'Scout',
      type: 'agent',
    })
    await deleteUser(db, 'u1')
    expect(await getUserById(db, 'u1')).toBeUndefined()
  })

  it('validateHandle accepts mentionable handles and rejects the rest', () => {
    // Handles must survive @mention parsing (\w+, lowercased) — see chat's
    // parseMentions — so only lowercase word characters are allowed.
    expect(validateHandle('scout')).toBe('scout')
    expect(validateHandle('scout_2')).toBe('scout_2')
    for (const bad of ['', 'Scout', 'sc out', 'sc-out', 'sc.out', '@scout']) {
      expect(() => validateHandle(bad)).toThrow(/handle/i)
    }
  })

  it('lists users in creation order', async () => {
    await createUser(db, {
      id: 'a',
      handle: 'a',
      displayName: 'A',
      type: 'human',
    })
    await createUser(db, {
      id: 'b',
      handle: 'b',
      displayName: 'B',
      type: 'agent',
    })
    expect((await listUsers(db)).map((u) => u.id)).toEqual(['a', 'b'])
  })

  describe('getUsersByIds', () => {
    it('batch-resolves the requested ids and ignores the rest', async () => {
      await createUser(db, {
        id: 'a',
        handle: 'a',
        displayName: 'A',
        type: 'human',
      })
      await createUser(db, {
        id: 'b',
        handle: 'b',
        displayName: 'B',
        type: 'agent',
      })
      await createUser(db, {
        id: 'c',
        handle: 'c',
        displayName: 'C',
        type: 'agent',
      })

      const found = await getUsersByIds(db, ['a', 'c', 'no-such-id'])
      expect(found.map((u) => u.id).sort()).toEqual(['a', 'c'])
    })

    it('short-circuits on an empty id list without querying', async () => {
      expect(await getUsersByIds(db, [])).toEqual([])
    })
  })

  describe('seedCrew', () => {
    it('seeds the operator and the agents', async () => {
      await seedCrew(db)
      const handles = (await listUsers(db)).map((u) => u.handle).sort()
      expect(handles).toEqual([
        'babysitter',
        'bix',
        'builder',
        'captain',
        'dot',
        'hand',
        'tilde',
      ])
      const captain = defined(await getUserByHandle(db, 'captain'))
      expect(captain.type).toBe('human')
      expect(captain.displayName).toBe('Captain')
      const tilde = defined(await getUserByHandle(db, 'tilde'))
      expect(tilde.type).toBe('agent')
      expect(tilde.displayName).toBe('Tilde')
      // Every seeded member has a non-empty handle and display name.
      for (const u of await listUsers(db)) {
        expect(u.handle).not.toBe('')
        expect(u.displayName).not.toBe('')
      }
    })

    it('is idempotent — running twice leaves one row per handle', async () => {
      await seedCrew(db)
      await seedCrew(db)
      expect(await listUsers(db)).toHaveLength(SEED_AGENTS.length + 1)
    })

    it('seeds the configured operator, not a hardcoded name', async () => {
      await seedCrew(db, { handle: 'drufball', displayName: 'Dru' })
      const dru = defined(await getUserByHandle(db, 'drufball'))
      expect(dru.type).toBe('human')
      expect(dru.displayName).toBe('Dru')
      expect(await getUserByHandle(db, 'captain')).toBeUndefined()
    })

    it('seeds every agent with the schema defaults — full tools, no prompt', async () => {
      await seedCrew(db)
      const tilde = defined(await getUserByHandle(db, 'tilde'))
      const captain = defined(await getUserByHandle(db, 'captain'))
      // seedCrew only creates the rows; seedAgentConfig (hull/agent) is what
      // writes each agent's actual config onto them.
      expect(tilde.systemPrompt).toBeNull()
      expect(tilde.tools).toBeNull()
      expect(captain.systemPrompt).toBeNull()
    })

    it('does not clobber an edited displayName on re-seed', async () => {
      await seedCrew(db)
      const captain = defined(await getUserByHandle(db, 'captain'))
      // a later hand-edit to the row should survive a re-seed
      await db
        .update(users)
        .set({ displayName: 'Cap' })
        .where(eq(users.handle, 'captain'))
      await seedCrew(db)
      expect(defined(await getUserByHandle(db, 'captain')).displayName).toBe(
        'Cap',
      )
      expect(defined(await getUserByHandle(db, 'captain')).id).toBe(captain.id)
    })
  })
})
