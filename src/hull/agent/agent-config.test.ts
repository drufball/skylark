import { uuidv7 } from '@earendil-works/pi-agent-core'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'

import { getUserByHandle, seedCrew, updateAgentUser } from '@hull/users/service'

import {
  createExtension,
  getExtensionByName,
  getExtensionsByIds,
  hasAgentConfig,
  listExtensions,
  registerExtension,
  resolveExtensionPaths,
  seedAgentConfig,
  BUILDER_CONFIG,
  GENERAL_CONFIG,
  CHAT_CONFIG,
  BUILD_GATES_EXTENSION,
} from './agent-config'

describe('hasAgentConfig', () => {
  const blank = {
    systemPrompt: null,
    tools: null,
    readContextFiles: true,
    useRepoSkills: true,
    extensionIds: [],
    model: null,
  }

  it('is false for a row that still carries every schema default', () => {
    expect(hasAgentConfig(blank as never)).toBe(false)
  })

  it('is true when any single field has been touched', () => {
    expect(hasAgentConfig({ ...blank, systemPrompt: 'hi' } as never)).toBe(true)
    expect(hasAgentConfig({ ...blank, tools: ['read'] } as never)).toBe(true)
    expect(hasAgentConfig({ ...blank, readContextFiles: false } as never)).toBe(
      true,
    )
    expect(hasAgentConfig({ ...blank, useRepoSkills: false } as never)).toBe(
      true,
    )
    expect(hasAgentConfig({ ...blank, extensionIds: ['e1'] } as never)).toBe(
      true,
    )
    expect(hasAgentConfig({ ...blank, model: 'opus' } as never)).toBe(true)
  })
})

describe('extensions registry', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

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

  it('resolves extension ids to their registry paths, in order', async () => {
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
    const paths = await resolveExtensionPaths(db, [b.id, a.id])
    expect(paths).toEqual(['path/b.ts', 'path/a.ts'])
  })

  it('throws if a config references an unknown extension id', async () => {
    await expect(resolveExtensionPaths(db, ['nope'])).rejects.toThrow(
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
})

describe('seedAgentConfig', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('registers build-gates and configures the role crew, creating any missing', async () => {
    // Nothing seeded yet — seedAgentConfig must create builder/hand/babysitter
    // itself, the same rows seedCrew would have made.
    await seedAgentConfig(db)
    await seedAgentConfig(db) // twice — must not duplicate or throw

    const ext = defined(
      await getExtensionByName(db, BUILD_GATES_EXTENSION.name),
    )
    expect(await listExtensions(db)).toHaveLength(1)

    const builder = defined(await getUserByHandle(db, 'builder'))
    expect(builder.tools).toBeNull()
    expect(builder.readContextFiles).toBe(true)
    expect(builder.useRepoSkills).toBe(true)
    expect(builder.extensionIds).toEqual([ext.id])
    expect(builder.systemPrompt).toMatch(/build-feature/i)

    const hand = defined(await getUserByHandle(db, 'hand'))
    expect(hand.tools).toBeNull()
    expect(hand.extensionIds).toEqual([])
    expect(hand.systemPrompt).toMatch(/issue/i)

    const babysitter = defined(await getUserByHandle(db, 'babysitter'))
    expect(babysitter.tools).toEqual(['read', 'bash'])
    expect(babysitter.extensionIds).toEqual([])
    expect(babysitter.readContextFiles).toBe(false)
    // Repo-skill access — so it can actually load the babysit-pr skill it's
    // told to follow.
    expect(babysitter.useRepoSkills).toBe(true)
    expect(babysitter.systemPrompt).toMatch(/babysit-pr/i)
    expect(babysitter.systemPrompt).toMatch(/background/i)
    expect(babysitter.systemPrompt).toMatch(/@builder/i)
  })

  it('gives every other agent the chat-pilot config', async () => {
    await seedCrew(db)
    await seedAgentConfig(db)

    const tilde = defined(await getUserByHandle(db, 'tilde'))
    expect(tilde.tools).toEqual(['read', 'bash'])
    expect(tilde.readContextFiles).toBe(false)
    expect(tilde.useRepoSkills).toBe(false)
    expect(tilde.extensionIds).toEqual([])
    expect(tilde.systemPrompt).toMatch(/pilot/i)

    const captain = defined(await getUserByHandle(db, 'captain'))
    expect(captain.systemPrompt).toBeNull() // humans are never touched
  })

  it('seeded prompts keep their load-bearing contract lines', async () => {
    await seedAgentConfig(db)

    const builder = defined(await getUserByHandle(db, 'builder'))
    expect(builder.systemPrompt).toContain('red-green TDD')
    expect(builder.systemPrompt).toContain('open a PR')
    expect(builder.systemPrompt).toContain('hand the baton to @babysitter')
    expect(builder.systemPrompt).toContain('`background` tool')
    expect(builder.systemPrompt).toContain('END YOUR TURN')

    const babysitter = defined(await getUserByHandle(db, 'babysitter'))
    expect(babysitter.systemPrompt).toContain('babysit-pr')
    expect(babysitter.systemPrompt).toContain('`background` tool')
    expect(babysitter.systemPrompt).toContain('mark the issue done')
    expect(babysitter.systemPrompt).toContain('hand the baton back')
    expect(babysitter.systemPrompt).toContain('never write code')

    const hand = defined(await getUserByHandle(db, 'hand'))
    expect(hand.systemPrompt).toContain('issue')
    expect(hand.systemPrompt).toContain('report back')
  })

  it('babysitter config points at the babysit-pr skill instead of duplicating it', async () => {
    await seedAgentConfig(db)
    const prompt =
      defined(await getUserByHandle(db, 'babysitter')).systemPrompt ?? ''

    // The merge-state playbook (mergeStateStatus, CLEAN/DIRTY/BEHIND/BLOCKED,
    // the rebase-and-force-push recipe) lives only in the skill now — the
    // system prompt just points at it plus the Skylark-specific handoff bits.
    expect(prompt).toContain('babysit-pr skill')
    expect(prompt).not.toContain('mergeStateStatus')
    expect(prompt).toContain('hand off to OWNER')
    expect(prompt).toContain('@builder')
  })

  it('never overwrites a role agent whose config the captain already touched', async () => {
    await seedAgentConfig(db)
    const builder = defined(await getUserByHandle(db, 'builder'))
    await updateAgentUser(db, builder.id, {
      systemPrompt: 'build it my way',
    })

    await seedAgentConfig(db)
    expect(defined(await getUserByHandle(db, 'builder')).systemPrompt).toBe(
      'build it my way',
    )
  })

  it("never overwrites a non-role agent's customized config", async () => {
    await seedCrew(db)
    const bix = defined(await getUserByHandle(db, 'bix'))
    await updateAgentUser(db, bix.id, {
      systemPrompt: 'I review architecture, differently',
      tools: ['read'],
    })

    await seedAgentConfig(db)
    const after = defined(await getUserByHandle(db, 'bix'))
    expect(after.systemPrompt).toBe('I review architecture, differently')
    expect(after.tools).toEqual(['read'])
  })

  it('is safe to run before seedCrew — role agents it creates are still configured', async () => {
    await seedAgentConfig(db) // no seedCrew first
    const builder = defined(await getUserByHandle(db, 'builder'))
    expect(builder.systemPrompt).toEqual(BUILDER_CONFIG.systemPrompt)
    // But builder/hand/babysitter are the only agents it knows to create —
    // tilde/bix/dot only exist once seedCrew runs.
    expect(await getUserByHandle(db, 'tilde')).toBeUndefined()
  })

  it('exports the same content constants the seed uses, for callers that need them', () => {
    expect(CHAT_CONFIG.systemPrompt).toMatch(/pilot/i)
    expect(GENERAL_CONFIG.systemPrompt).toMatch(/general-purpose/i)
  })
})
