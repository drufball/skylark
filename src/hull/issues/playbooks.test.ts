import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'
import { seedAndWireProfiles, getProfileByName } from '@hull/agent/profiles'
import { createUser, getUserByHandle, seedCrew } from '@hull/users/service'

import {
  BUILD_PLAYBOOK_NAME,
  getPlaybookByName,
  listPlaybooks,
  playbookFor,
  requirePlaybook,
  seedPlaybooks,
  upsertPlaybook,
  validatePlaybookInput,
} from './playbooks'
import { createIssue } from './service'

let db: Database
let close: () => Promise<void>
let builderId: string
let tildeId: string

beforeEach(async () => {
  ;({ db, close } = await freshDb())
  await seedCrew(db)
  await seedAndWireProfiles(db)
  builderId = defined(await getUserByHandle(db, 'builder')).id
  tildeId = defined(await getUserByHandle(db, 'tilde')).id
})

afterEach(async () => {
  await close()
})

describe('validatePlaybookInput', () => {
  it('accepts a well-shaped input, trimming the name and defaulting description', () => {
    expect(
      validatePlaybookInput({
        name: '  review ',
        memberIds: ['u1'],
        entrypointId: 'u1',
      }),
    ).toEqual({
      name: 'review',
      description: '',
      memberIds: ['u1'],
      entrypointId: 'u1',
    })
  })

  it('keeps a string description and drops a non-string one', () => {
    expect(
      validatePlaybookInput({
        name: 'review',
        description: 'read and judge',
        memberIds: ['u1'],
        entrypointId: 'u1',
      }).description,
    ).toBe('read and judge')
    expect(
      validatePlaybookInput({
        name: 'review',
        description: 42,
        memberIds: ['u1'],
        entrypointId: 'u1',
      }).description,
    ).toBe('')
  })

  it('rejects a missing or blank name', () => {
    expect(() =>
      validatePlaybookInput({ memberIds: ['u1'], entrypointId: 'u1' }),
    ).toThrow(/needs a name/)
    expect(() =>
      validatePlaybookInput({
        name: '   ',
        memberIds: ['u1'],
        entrypointId: 'u1',
      }),
    ).toThrow(/needs a name/)
  })

  it('rejects memberIds that are not a list of strings', () => {
    expect(() =>
      validatePlaybookInput({ name: 'x', entrypointId: 'u1' }),
    ).toThrow(/memberIds/)
    expect(() =>
      validatePlaybookInput({
        name: 'x',
        memberIds: ['u1', 7],
        entrypointId: 'u1',
      }),
    ).toThrow(/memberIds/)
  })

  it('rejects a non-string entrypointId', () => {
    expect(() =>
      validatePlaybookInput({ name: 'x', memberIds: ['u1'] }),
    ).toThrow(/entrypointId/)
  })
})

describe('requirePlaybook', () => {
  it('resolves an existing playbook by name and by id', async () => {
    await seedPlaybooks(db)
    const build = defined(await getPlaybookByName(db, BUILD_PLAYBOOK_NAME))
    expect((await requirePlaybook(db, { name: BUILD_PLAYBOOK_NAME })).id).toBe(
      build.id,
    )
    expect((await requirePlaybook(db, { id: build.id })).name).toBe(
      BUILD_PLAYBOOK_NAME,
    )
  })

  it('throws the friendly error listing what exists', async () => {
    await seedPlaybooks(db)
    await expect(requirePlaybook(db, { name: 'bogus' })).rejects.toThrow(
      /No such playbook: bogus \(have: build, general\)/,
    )
    await expect(requirePlaybook(db, { id: uuidv7() })).rejects.toThrow(
      /No such playbook: .+ \(have: build, general\)/,
    )
  })

  it('omits the have-list on a ship with no playbooks at all', async () => {
    await expect(requirePlaybook(db, { name: 'bogus' })).rejects.toThrow(
      /^No such playbook: bogus$/,
    )
  })
})

describe('upsertPlaybook', () => {
  it('creates a playbook and converges on re-upsert, keeping the id stable', async () => {
    const first = await upsertPlaybook(db, {
      name: 'review',
      description: 'read and judge',
      memberIds: [builderId, tildeId],
      entrypointId: builderId,
    })
    expect(first.memberIds).toEqual([builderId, tildeId])

    const second = await upsertPlaybook(db, {
      name: 'review',
      description: 'read and judge, updated',
      memberIds: [tildeId],
      entrypointId: tildeId,
    })
    expect(second.id).toBe(first.id)
    expect(second.entrypointId).toBe(tildeId)
    expect(defined(await getPlaybookByName(db, 'review')).description).toBe(
      'read and judge, updated',
    )
  })

  it('refuses an entrypoint that is not a member', async () => {
    await expect(
      upsertPlaybook(db, {
        name: 'bad',
        memberIds: [tildeId],
        entrypointId: builderId,
      }),
    ).rejects.toThrow(/member/i)
  })

  it('refuses an empty member list, naming the empty roster as the problem', async () => {
    // The message must be the empty-roster one, not a downstream complaint
    // (the entrypoint check also says "member" — that would mask this guard).
    await expect(
      upsertPlaybook(db, {
        name: 'empty',
        memberIds: [],
        entrypointId: builderId,
      }),
    ).rejects.toThrow(/at least one member/i)
  })

  it('refuses a duplicated roster entry', async () => {
    await expect(
      upsertPlaybook(db, {
        name: 'echo',
        memberIds: [builderId, builderId],
        entrypointId: builderId,
      }),
    ).rejects.toThrow(/once/i)
  })

  it('refuses a member id that is not crew at all', async () => {
    await expect(
      upsertPlaybook(db, {
        name: 'ghost',
        memberIds: [builderId, uuidv7()],
        entrypointId: builderId,
      }),
    ).rejects.toThrow(/no such crew/i)
  })

  it('defaults the description to empty', async () => {
    const p = await upsertPlaybook(db, {
      name: 'terse',
      memberIds: [builderId],
      entrypointId: builderId,
    })
    expect(p.description).toBe('')
  })

  it('refuses a human member — playbooks are agent rosters', async () => {
    const human = defined(await getUserByHandle(db, 'captain'))
    await expect(
      upsertPlaybook(db, {
        name: 'mixed',
        memberIds: [builderId, human.id],
        entrypointId: builderId,
      }),
    ).rejects.toThrow(/agent/i)
  })
})

describe('seedPlaybooks', () => {
  it('seeds build (builder + babysitter, entry: builder) and general (entry: hand), idempotently', async () => {
    await seedPlaybooks(db)
    await seedPlaybooks(db) // twice is fine

    const babysitter = defined(await getUserByHandle(db, 'babysitter'))
    const build = defined(await getPlaybookByName(db, 'build'))
    expect(build.entrypointId).toBe(builderId)
    expect(build.memberIds).toEqual([builderId, babysitter.id])

    const hand = defined(await getUserByHandle(db, 'hand'))
    const general = defined(await getPlaybookByName(db, 'general'))
    expect(general.entrypointId).toBe(hand.id)

    expect((await listPlaybooks(db)).map((p) => p.name).sort()).toEqual([
      'build',
      'general',
    ])
  })

  it('an ensure run appends newly-standard members to an existing playbook, keeping edits', async () => {
    // The ship's build playbook predates the babysitter (the M2 shape), and
    // the crew has customised it: extra member, own description.
    const babysitter = defined(await getUserByHandle(db, 'babysitter'))
    await upsertPlaybook(db, {
      name: 'build',
      description: 'our build, our rules',
      memberIds: [builderId, tildeId],
      entrypointId: builderId,
    })

    await seedPlaybooks(db) // an ordinary boot

    const build = defined(await getPlaybookByName(db, 'build'))
    // The factory-required babysitter joined the roster…
    expect(build.memberIds).toContain(babysitter.id)
    // …and the captain's edits survived.
    expect(build.memberIds).toContain(tildeId)
    expect(build.description).toBe('our build, our rules')
    expect(build.entrypointId).toBe(builderId)
  })

  it('boot seeding never clobbers the captain’s edits — ensure, don’t converge', async () => {
    await seedPlaybooks(db)
    // The crew edits the general playbook in the Playbooks tab…
    await upsertPlaybook(db, {
      name: 'general',
      description: 'my custom brief',
      memberIds: [tildeId],
      entrypointId: tildeId,
    })
    // …and the next server boot must leave that edit standing.
    await seedPlaybooks(db)
    const general = defined(await getPlaybookByName(db, 'general'))
    expect(general.description).toBe('my custom brief')
    expect(general.entrypointId).toBe(tildeId)
    // The explicit converge (the factory-reset door) rewrites it.
    await seedPlaybooks(db, { convergeAll: true })
    const reset = defined(await getPlaybookByName(db, 'general'))
    expect(reset.entrypointId).not.toBe(tildeId)
  })

  it('skips playbooks whose crew is not aboard, without failing', async () => {
    // A fresh database with no crew at all: seeding must be a quiet no-op,
    // not a crash — seedCrew always runs first in the real boot paths.
    const bare = await freshDb()
    try {
      await seedPlaybooks(bare.db)
      expect(await listPlaybooks(bare.db)).toEqual([])
    } finally {
      await bare.close()
    }
  })

  it('skips a playbook missing ONE standard member, seeding the rest', async () => {
    // Builder and hand are aboard, the babysitter is not: the build roster is
    // incomplete, so `build` is skipped (not seeded short-handed, not fatal)
    // while `general` still lands.
    const bare = await freshDb()
    try {
      for (const handle of ['builder', 'hand']) {
        await createUser(bare.db, {
          id: uuidv7(),
          handle,
          displayName: handle,
          type: 'agent',
        })
      }
      await seedPlaybooks(bare.db)
      expect(await getPlaybookByName(bare.db, 'build')).toBeUndefined()
      expect(await getPlaybookByName(bare.db, 'general')).toBeDefined()
    } finally {
      await bare.close()
    }
  })

  it('gives the hand agent the general profile, not the chat default', async () => {
    await seedPlaybooks(db)
    const hand = defined(await getUserByHandle(db, 'hand'))
    const generalProfile = defined(await getProfileByName(db, 'general'))
    expect(hand.profileId).toBe(generalProfile.id)
  })

  it('gives the builder its builder profile — entrypoints boot from users.profileId now', async () => {
    const builder = defined(await getUserByHandle(db, 'builder'))
    const builderProfile = defined(await getProfileByName(db, 'builder'))
    expect(builder.profileId).toBe(builderProfile.id)
  })
})

describe('playbookFor', () => {
  it('resolves an issue with no playbook to the build default', async () => {
    await seedPlaybooks(db)
    const issue = await createIssue(db, { title: 'legacy', authorId: tildeId })
    const playbook = defined(await playbookFor(db, issue))
    expect(playbook.name).toBe(BUILD_PLAYBOOK_NAME)
  })

  it('resolves an issue to its chosen playbook', async () => {
    await seedPlaybooks(db)
    const general = defined(await getPlaybookByName(db, 'general'))
    const issue = await createIssue(db, {
      title: 'research something',
      authorId: tildeId,
      playbookId: general.id,
    })
    expect(defined(await playbookFor(db, issue)).name).toBe('general')
  })

  it('is undefined when nothing is seeded — the orchestrator falls back to the legacy builder path', async () => {
    const issue = await createIssue(db, { title: 'bare', authorId: tildeId })
    expect(await playbookFor(db, issue)).toBeUndefined()
  })
})

describe('createIssue with a playbook', () => {
  it('records the playbook id', async () => {
    await seedPlaybooks(db)
    const general = defined(await getPlaybookByName(db, 'general'))
    const issue = await createIssue(db, {
      title: 'summarize the logs',
      authorId: tildeId,
      playbookId: general.id,
    })
    expect(issue.playbookId).toBe(general.id)
  })

  it('leaves playbookId null by default (build semantics)', async () => {
    const issue = await createIssue(db, { title: 'plain', authorId: tildeId })
    expect(issue.playbookId).toBeNull()
  })

  it('refuses an unknown playbook id via the FK', async () => {
    await expect(
      createIssue(db, {
        title: 'bogus',
        authorId: tildeId,
        playbookId: uuidv7(),
      }),
    ).rejects.toThrow()
  })
})
