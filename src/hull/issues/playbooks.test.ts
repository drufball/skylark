import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'
import { seedAndWireProfiles, getProfileByName } from '@hull/agent/profiles'
import { getUserByHandle, seedCrew } from '@hull/users/service'

import {
  BUILD_PLAYBOOK_NAME,
  getPlaybookByName,
  listPlaybooks,
  playbookFor,
  seedPlaybooks,
  upsertPlaybook,
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

  it('refuses an empty member list', async () => {
    await expect(
      upsertPlaybook(db, {
        name: 'empty',
        memberIds: [],
        entrypointId: builderId,
      }),
    ).rejects.toThrow(/member/i)
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
    const human = defined(await getUserByHandle(db, 'drufball'))
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
  it('seeds build (entry: builder) and general (entry: hand), idempotently', async () => {
    await seedPlaybooks(db)
    await seedPlaybooks(db) // twice is fine

    const build = defined(await getPlaybookByName(db, 'build'))
    expect(build.entrypointId).toBe(builderId)
    expect(build.memberIds).toContain(builderId)

    const hand = defined(await getUserByHandle(db, 'hand'))
    const general = defined(await getPlaybookByName(db, 'general'))
    expect(general.entrypointId).toBe(hand.id)

    expect((await listPlaybooks(db)).map((p) => p.name).sort()).toEqual([
      'build',
      'general',
    ])
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
