import { uuidv7 } from '@earendil-works/pi-agent-core'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'

import { getUserByHandle, seedCrew } from '@hull/users/service'

import {
  createProfile,
  createExtension,
  getProfileByName,
  getExtensionByName,
  getExtensionsByIds,
  listProfiles,
  listExtensions,
  normalizeProfileInput,
  registerExtension,
  upsertProfile,
  resolveProfileExtensionPaths,
  seedProfiles,
  seedAndWireProfiles,
  CHAT_PROFILE,
  BUILDER_PROFILE,
  BUILD_GATES_EXTENSION,
} from './profiles'

describe('normalizeProfileInput', () => {
  it('trims the name and folds blank text / empty tools to null', () => {
    expect(
      normalizeProfileInput({
        name: '  researcher  ',
        systemPrompt: '   ',
        tools: [],
        readContextFiles: false,
        useRepoSkills: true,
        extensionIds: [],
        model: '',
      }),
    ).toEqual({
      name: 'researcher',
      systemPrompt: null,
      tools: null,
      readContextFiles: false,
      useRepoSkills: true,
      extensionIds: [],
      model: null,
    })
  })

  it('keeps real values', () => {
    const input = {
      name: 'builder',
      systemPrompt: 'build it',
      tools: ['read', 'bash'],
      readContextFiles: true,
      useRepoSkills: true,
      extensionIds: ['e1'],
      model: 'claude-opus-4-5',
    }
    expect(normalizeProfileInput(input)).toEqual(input)
  })
})

describe('agent profiles + extensions service', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('creates and reads a profile by name', async () => {
    const id = uuidv7()
    await createProfile(db, {
      id,
      name: 'chat',
      systemPrompt: 'pilot the ship',
      tools: ['read', 'bash'],
      readContextFiles: false,
      useRepoSkills: false,
      extensionIds: [],
      model: null,
    })

    const row = defined(await getProfileByName(db, 'chat'))
    expect(row.id).toBe(id)
    expect(row.tools).toEqual(['read', 'bash'])
    expect(row.readContextFiles).toBe(false)
    expect(row.systemPrompt).toBe('pilot the ship')
  })

  it('stores null tools as "default coding tools"', async () => {
    await createProfile(db, {
      id: uuidv7(),
      name: 'builder',
      systemPrompt: null,
      tools: null,
      readContextFiles: true,
      useRepoSkills: true,
      extensionIds: [],
      model: null,
    })
    const row = defined(await getProfileByName(db, 'builder'))
    expect(row.tools).toBeNull()
  })

  it('creates and reads an extension by name', async () => {
    const id = uuidv7()
    await createExtension(db, {
      id,
      name: 'build-gates',
      description: 'commit/landing/session gates',
      path: 'src/hull/agent/extensions/build-gates/index.ts',
    })
    const row = defined(await getExtensionByName(db, 'build-gates'))
    expect(row.id).toBe(id)
    expect(row.path).toContain('build-gates')
  })

  it('registerExtension is idempotent by name, updating path/description', async () => {
    const first = await registerExtension(db, {
      name: 'build-gates',
      description: 'old',
      path: 'old/path.ts',
    })
    const second = await registerExtension(db, {
      name: 'build-gates',
      description: 'new',
      path: 'new/path.ts',
    })
    expect(second.id).toBe(first.id) // same row reused
    expect(second.description).toBe('new')
    expect(second.path).toBe('new/path.ts')
    expect(await listExtensions(db)).toHaveLength(1)
  })

  it('upsertProfile is idempotent by name, updating fields', async () => {
    const first = await upsertProfile(db, {
      name: 'chat',
      systemPrompt: 'a',
      tools: ['read'],
      readContextFiles: false,
      useRepoSkills: false,
      extensionIds: [],
      model: null,
    })
    const second = await upsertProfile(db, {
      name: 'chat',
      systemPrompt: 'b',
      tools: ['read', 'bash'],
      readContextFiles: false,
      useRepoSkills: false,
      extensionIds: [],
      model: null,
    })
    expect(second.id).toBe(first.id)
    expect(second.systemPrompt).toBe('b')
    expect(second.tools).toEqual(['read', 'bash'])
    expect(await listProfiles(db)).toHaveLength(1)
  })

  it("resolves a profile's extensionIds to their registry paths, in order", async () => {
    const a = await registerExtension(db, {
      name: 'a',
      description: 'a',
      path: 'path/a.ts',
    })
    const b = await registerExtension(db, {
      name: 'b',
      description: 'b',
      path: 'path/b.ts',
    })
    // order asked for is [b, a] — result must preserve it
    const paths = await resolveProfileExtensionPaths(db, [b.id, a.id])
    expect(paths).toEqual(['path/b.ts', 'path/a.ts'])
  })

  it('throws if a profile references an unknown extension id', async () => {
    await expect(resolveProfileExtensionPaths(db, ['nope'])).rejects.toThrow(
      /unknown extension/i,
    )
  })

  it('getExtensionsByIds returns only the matching rows', async () => {
    const a = await registerExtension(db, {
      name: 'a',
      description: 'a',
      path: 'a.ts',
    })
    await registerExtension(db, { name: 'b', description: 'b', path: 'b.ts' })
    const rows = await getExtensionsByIds(db, [a.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('a')
  })

  it('seedProfiles creates the build-gates extension and chat + builder profiles, idempotently', async () => {
    await seedProfiles(db)
    await seedProfiles(db) // twice — must not duplicate

    const ext = defined(
      await getExtensionByName(db, BUILD_GATES_EXTENSION.name),
    )
    const chat = defined(await getProfileByName(db, CHAT_PROFILE.name))
    const builder = defined(await getProfileByName(db, BUILDER_PROFILE.name))

    // chat: read+bash, no context files, no skills, no extensions
    expect(chat.tools).toEqual(['read', 'bash'])
    expect(chat.readContextFiles).toBe(false)
    expect(chat.useRepoSkills).toBe(false)
    expect(chat.extensionIds).toEqual([])
    expect(chat.systemPrompt).toMatch(/pilot/i)

    // builder: default tools (null), context + skills, build-gates extension
    expect(builder.tools).toBeNull()
    expect(builder.readContextFiles).toBe(true)
    expect(builder.useRepoSkills).toBe(true)
    expect(builder.extensionIds).toEqual([ext.id])
    expect(builder.systemPrompt).toMatch(/ship-feature/i)

    expect(await listProfiles(db)).toHaveLength(2)
    expect(await listExtensions(db)).toHaveLength(1)
  })

  it('seedAndWireProfiles seeds profiles AND points agent crew at the chat profile', async () => {
    await seedCrew(db)
    await seedAndWireProfiles(db)
    await seedAndWireProfiles(db) // idempotent end to end

    const chat = defined(await getProfileByName(db, CHAT_PROFILE.name))
    const tilde = defined(await getUserByHandle(db, 'tilde'))
    const dru = defined(await getUserByHandle(db, 'drufball'))
    expect(tilde.profileId).toBe(chat.id) // agent → chat
    expect(dru.profileId).toBeNull() // human → untouched
    expect(await listProfiles(db)).toHaveLength(2)
  })
})
