import { uuidv7 } from '@earendil-works/pi-agent-core'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'

import { getUserByHandle, seedCrew, setUserProfile } from '@hull/users/service'

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
  BABYSITTER_PROFILE,
  BUILDER_PROFILE,
  GENERAL_PROFILE,
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

  it('registerExtension survives a concurrent duplicate — one row, no throw', async () => {
    // Two processes seed at once (server boot racing a CLI seed). Both miss
    // the get-then-insert read; the writes must still converge on one row.
    const [a, b] = await Promise.all([
      registerExtension(db, {
        name: 'build-gates',
        description: 'from the server',
        path: 'server/path.ts',
      }),
      registerExtension(db, {
        name: 'build-gates',
        description: 'from the cli',
        path: 'cli/path.ts',
      }),
    ])
    expect(a.id).toBe(b.id)
    expect(await listExtensions(db)).toHaveLength(1)
  })

  it('upsertProfile survives a concurrent duplicate — one row, no throw', async () => {
    const input = {
      systemPrompt: 'a',
      tools: null,
      readContextFiles: true,
      useRepoSkills: true,
      extensionIds: [],
      model: null,
    }
    const [a, b] = await Promise.all([
      upsertProfile(db, { name: 'builder', ...input }),
      upsertProfile(db, { name: 'builder', ...input }),
    ])
    expect(a.id).toBe(b.id)
    expect(await listProfiles(db)).toHaveLength(1)
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

    // general: full tools + ship context, no gates — the issue is the brief
    const general = defined(await getProfileByName(db, GENERAL_PROFILE.name))
    expect(general.tools).toBeNull()
    expect(general.extensionIds).toEqual([])
    expect(general.readContextFiles).toBe(true)
    expect(general.useRepoSkills).toBe(true)

    // babysitter: read+bash only (it shepherds PRs, never writes code), no
    // ship context or repo skills (it operates gh + the issue CLI, it doesn't
    // build), and its brief names the background tool and the hand-back.
    const babysitter = defined(
      await getProfileByName(db, BABYSITTER_PROFILE.name),
    )
    expect(babysitter.tools).toEqual(['read', 'bash'])
    expect(babysitter.extensionIds).toEqual([])
    expect(babysitter.readContextFiles).toBe(false)
    expect(babysitter.useRepoSkills).toBe(false)
    expect(babysitter.systemPrompt).toMatch(/background/i)
    expect(babysitter.systemPrompt).toMatch(/@builder/i)

    expect(await listProfiles(db)).toHaveLength(4)
    expect(await listExtensions(db)).toHaveLength(1)
  })

  it('seeded prompts keep their load-bearing contract lines', async () => {
    await seedProfiles(db)
    const prompt = async (name: string) =>
      defined(await getProfileByName(db, name)).systemPrompt ?? ''

    // chat: operates, never modifies; change requests become issues.
    const chat = await prompt(CHAT_PROFILE.name)
    expect(chat).toContain('never modify the ship')
    expect(chat).toContain('file an issue')

    // builder: TDD to an OPEN PR, then hand the baton and stop; long waits go
    // through the background tool, never a foreground poll.
    const builder = await prompt(BUILDER_PROFILE.name)
    expect(builder).toContain('red-green TDD')
    expect(builder).toContain('open a PR')
    expect(builder).toContain('hand the baton to @babysitter')
    expect(builder).toContain('`background` tool')
    expect(builder).toContain('END YOUR TURN')

    // babysitter: waits in the background, merges when green, hands fixes
    // back to the builder, and never writes code itself.
    const babysitter = await prompt(BABYSITTER_PROFILE.name)
    expect(babysitter).toContain('`background` tool')
    expect(babysitter).toContain('gh pr merge')
    expect(babysitter).toContain('--squash --delete-branch')
    expect(babysitter).toContain('mark the issue done')
    expect(babysitter).toContain('hand the baton back')
    expect(babysitter).toContain('never write code')

    // general: does what the issue says and reports back on its thread.
    const general = await prompt(GENERAL_PROFILE.name)
    expect(general).toContain('issue')
    expect(general).toContain('report back')
  })

  it('babysitter profile includes merge state checking instructions', async () => {
    await seedProfiles(db)
    const babysitter = defined(
      await getProfileByName(db, BABYSITTER_PROFILE.name),
    )
    const prompt = babysitter.systemPrompt ?? ''

    // Must check merge state status BEFORE merging
    expect(prompt).toContain('gh pr view')
    expect(prompt).toContain('mergeStateStatus')

    // Must handle CLEAN/UNSTABLE → merge
    expect(prompt).toContain('CLEAN')
    expect(prompt).toContain('UNSTABLE')
    expect(prompt).toContain('gh pr merge')
    expect(prompt).toContain('--squash --delete-branch')

    // Must handle DIRTY → hand off to builder with rebase brief (conflicts/dirty working tree)
    expect(prompt).toContain('DIRTY')
    expect(prompt).toContain('git fetch origin && git rebase origin/main')
    expect(prompt).toContain('git push --force-with-lease')

    // Must handle BEHIND → rebase+push then re-check
    expect(prompt).toContain('BEHIND')

    // Must handle BLOCKED → branch protection or required checks blocking merge
    expect(prompt).toContain('BLOCKED')

    // Must handle merge command failures → hand off with error, never end silently
    expect(prompt).toContain('merge command fails')
    expect(prompt).toContain('hand off')
  })

  it('re-seeding preserves a deliberately customized crew profile assignment', async () => {
    await seedCrew(db)
    await seedAndWireProfiles(db)
    // The captain points the builder at a hand-rolled profile…
    const custom = await upsertProfile(db, {
      name: 'my-builder',
      systemPrompt: 'build it my way',
      tools: null,
      readContextFiles: true,
      useRepoSkills: true,
      extensionIds: [],
      model: null,
    })
    const builder = defined(await getUserByHandle(db, 'builder'))
    await setUserProfile(db, builder.id, custom.id)

    // …and the next seed leaves that choice standing (only null-or-chat is
    // corrected back to the standard profile).
    await seedAndWireProfiles(db)
    expect(defined(await getUserByHandle(db, 'builder')).profileId).toBe(
      custom.id,
    )
  })

  it('an ensure-only seed leaves edited profiles alone; the converge seed resets them', async () => {
    await seedProfiles(db)
    const chat = defined(await getProfileByName(db, CHAT_PROFILE.name))
    await upsertProfile(db, {
      ...CHAT_PROFILE,
      systemPrompt: 'my edited pilot brief',
      extensionIds: [],
    })
    // The every-boot path must not undo the crew's edit…
    await seedProfiles(db, { convergeAll: false })
    expect(
      defined(await getProfileByName(db, CHAT_PROFILE.name)).systemPrompt,
    ).toBe('my edited pilot brief')
    // …while the explicit CLI seed converges back to the declared shape.
    await seedProfiles(db)
    expect(
      defined(await getProfileByName(db, CHAT_PROFILE.name)).systemPrompt,
    ).toMatch(/pilot a Skylark ship/i)
    expect(defined(await getProfileByName(db, CHAT_PROFILE.name)).id).toBe(
      chat.id,
    )
  })

  it('heals a DANGLING profileId — profiles recreated with new ids — back to the default', async () => {
    await seedCrew(db)
    await seedAndWireProfiles(db)
    const chat = defined(await getProfileByName(db, CHAT_PROFILE.name))
    const tilde = defined(await getUserByHandle(db, 'tilde'))
    // The live failure mode: agent_profiles was rebuilt, users kept old ids.
    // Nothing references the ghost id; a session boot would die on its FK.
    await setUserProfile(db, tilde.id, uuidv7())
    await seedAndWireProfiles(db, { convergeAll: false })
    expect(defined(await getUserByHandle(db, 'tilde')).profileId).toBe(chat.id)
  })

  it('healing leaves a VALID hand-picked profile alone', async () => {
    await seedCrew(db)
    await seedAndWireProfiles(db)
    const builderProfile = defined(
      await getProfileByName(db, BUILDER_PROFILE.name),
    )
    const bix = defined(await getUserByHandle(db, 'bix'))
    await setUserProfile(db, bix.id, builderProfile.id)
    await seedAndWireProfiles(db, { convergeAll: false })
    expect(defined(await getUserByHandle(db, 'bix')).profileId).toBe(
      builderProfile.id,
    )
  })

  it('seedAndWireProfiles seeds profiles AND points agent crew at the chat profile', async () => {
    await seedCrew(db)
    await seedAndWireProfiles(db)
    await seedAndWireProfiles(db) // idempotent end to end

    const chat = defined(await getProfileByName(db, CHAT_PROFILE.name))
    const tilde = defined(await getUserByHandle(db, 'tilde'))
    const captain = defined(await getUserByHandle(db, 'captain'))
    expect(tilde.profileId).toBe(chat.id) // agent → chat
    expect(captain.profileId).toBeNull() // human → untouched
    expect(await listProfiles(db)).toHaveLength(4)

    // The role crew boot with their own profiles, not the chat default.
    const babysitter = defined(await getUserByHandle(db, 'babysitter'))
    expect(babysitter.profileId).toBe(
      defined(await getProfileByName(db, BABYSITTER_PROFILE.name)).id,
    )
  })
})
