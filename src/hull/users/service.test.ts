import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'

import { users } from './schema'
import {
  assignDefaultAgentProfile,
  createUser,
  getUserByHandle,
  clearDanglingProfiles,
  getUserById,
  handleOf,
  listUsers,
  resolveActorHandle,
  seedCrew,
  setUserProfile,
  SEED_CREW,
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
      profileId: null,
    })
    const rewired = await updateAgentUser(db, 'u1', { profileId: 'p1' })
    expect(rewired).toMatchObject({
      displayName: 'Scout Prime',
      profileId: 'p1',
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

  describe('clearDanglingProfiles', () => {
    it('nulls unresolved references, keeps valid ones, clears all when no profile exists', async () => {
      const agent = await createUser(db, {
        id: 'a1',
        handle: 'ghosted',
        displayName: 'Ghosted',
        type: 'agent',
      })
      const ok = await createUser(db, {
        id: 'a2',
        handle: 'fine',
        displayName: 'Fine',
        type: 'agent',
      })
      await setUserProfile(db, agent.id, 'ghost-profile')
      await setUserProfile(db, ok.id, 'real-profile')

      await clearDanglingProfiles(db, ['real-profile'])
      expect(defined(await getUserById(db, agent.id)).profileId).toBeNull()
      expect(defined(await getUserById(db, ok.id)).profileId).toBe(
        'real-profile',
      )

      // No valid profiles at all -> every reference is dangling.
      await clearDanglingProfiles(db, [])
      expect(defined(await getUserById(db, ok.id)).profileId).toBeNull()
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
        'dot',
        'drufball',
        'hand',
        'tilde',
      ])
      const dru = defined(await getUserByHandle(db, 'drufball'))
      expect(dru.type).toBe('human')
      expect(dru.displayName).toBe('Dru')
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
      expect(await listUsers(db)).toHaveLength(SEED_CREW.length)
    })

    it('assignDefaultAgentProfile sets agents (only) without a profile', async () => {
      await seedCrew(db)
      await assignDefaultAgentProfile(db, 'chat-profile')

      const tilde = defined(await getUserByHandle(db, 'tilde'))
      const dru = defined(await getUserByHandle(db, 'drufball'))
      expect(tilde.profileId).toBe('chat-profile') // agent → assigned
      expect(dru.profileId).toBeNull() // human → untouched
    })

    it("assignDefaultAgentProfile keeps an agent's existing profile", async () => {
      await seedCrew(db)
      const bix = defined(await getUserByHandle(db, 'bix'))
      await setUserProfile(db, bix.id, 'special')
      await assignDefaultAgentProfile(db, 'chat-profile')
      expect(defined(await getUserByHandle(db, 'bix')).profileId).toBe(
        'special',
      )
    })

    it('does not clobber an edited displayName on re-seed', async () => {
      await seedCrew(db)
      const dru = defined(await getUserByHandle(db, 'drufball'))
      // a later hand-edit to the row should survive a re-seed
      await db
        .update(users)
        .set({ displayName: 'Captain Dru' })
        .where(eq(users.handle, 'drufball'))
      await seedCrew(db)
      expect(defined(await getUserByHandle(db, 'drufball')).displayName).toBe(
        'Captain Dru',
      )
      expect(defined(await getUserByHandle(db, 'drufball')).id).toBe(dru.id)
    })
  })
})

describe('resolveActorHandle', () => {
  // Pure resolution: given the ambient inputs, which handle wins? The actual
  // reading of cookies/env is the thin impure edge (actor.ts); this is the rule.
  it('prefers the dev cookie override on the web', () => {
    expect(
      resolveActorHandle({
        context: 'web',
        cookieHandle: 'bix',
        operator: 'drufball',
      }),
    ).toBe('bix')
  })

  it('falls back to the configured operator on the web when no cookie', () => {
    expect(
      resolveActorHandle({
        context: 'web',
        cookieHandle: undefined,
        operator: 'drufball',
      }),
    ).toBe('drufball')
  })

  it('ignores a cookie in CLI context — only the operator matters there', () => {
    expect(
      resolveActorHandle({
        context: 'cli',
        cookieHandle: 'bix',
        operator: 'drufball',
      }),
    ).toBe('drufball')
  })
})
