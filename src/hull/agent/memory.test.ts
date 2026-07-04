import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import {
  agentMemoryDir,
  agentMemoryIndexPath,
  loadAgentMemory,
  starterMemoryIndex,
  withAgentMemory,
} from './memory'
import type { AgentConfig } from './session-config'

const CONFIG: AgentConfig = {
  systemPrompt: 'You pilot the ship.',
  tools: ['read', 'bash'],
  readContextFiles: false,
  useRepoSkills: false,
  extensionPaths: [],
  model: null,
}

describe('agent memory paths', () => {
  it('derives the folder and index from the handle', () => {
    expect(agentMemoryDir('tilde')).toBe('agents/tilde')
    expect(agentMemoryIndexPath('tilde')).toBe('agents/tilde/index.md')
  })
})

describe('withAgentMemory', () => {
  const memory = {
    userId: 'user-1',
    handle: 'tilde',
    index: '# Tilde\n\nI review architecture.',
  }

  it("appends identity, the index content, and the update commands after the config's prompt", () => {
    const boosted = withAgentMemory(CONFIG, memory)
    expect(boosted.systemPrompt).toContain('You pilot the ship.')
    expect(boosted.systemPrompt?.indexOf('You pilot the ship.')).toBe(0)
    expect(boosted.systemPrompt).toContain('You are @tilde')
    expect(boosted.systemPrompt).toContain('I review architecture.')
    expect(boosted.systemPrompt).toContain(
      'SKYLARK_ACTOR=user-1 npm run files -- write agents/tilde/<file>',
    )
    // Everything else about the config is untouched.
    expect(boosted.tools).toEqual(CONFIG.tools)
    expect(boosted.model).toBeNull()
  })

  it('stands alone when the config has no prompt of its own', () => {
    const boosted = withAgentMemory({ ...CONFIG, systemPrompt: null }, memory)
    expect(boosted.systemPrompt?.startsWith('You are @tilde')).toBe(true)
  })

  it('says the index is empty when it is missing or blank', () => {
    for (const index of [null, '', '   \n']) {
      const boosted = withAgentMemory(CONFIG, { ...memory, index })
      expect(boosted.systemPrompt).toContain('your index is empty')
    }
  })
})

describe('loadAgentMemory', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  const filesWith = (content: Record<string, string>) => ({
    read: (path: string) => Promise.resolve(content[path] ?? null),
  })

  it('resolves the agent and reads its index', async () => {
    const id = uuidv7()
    await createUser(db, {
      id,
      handle: 'tilde',
      displayName: 'Tilde',
      type: 'agent',
    })
    const memory = await loadAgentMemory(
      db,
      filesWith({ 'agents/tilde/index.md': '# notes' }),
      id,
    )
    expect(memory).toEqual({ userId: id, handle: 'tilde', index: '# notes' })
  })

  it('carries a null index when the agent has not written one yet', async () => {
    const id = uuidv7()
    await createUser(db, {
      id,
      handle: 'bix',
      displayName: 'Bix',
      type: 'agent',
    })
    const memory = await loadAgentMemory(db, filesWith({}), id)
    expect(memory?.index).toBeNull()
  })

  it('returns null for a missing user or a human', async () => {
    expect(await loadAgentMemory(db, filesWith({}), uuidv7())).toBeNull()
    const humanId = uuidv7()
    await createUser(db, {
      id: humanId,
      handle: 'dru',
      displayName: 'Dru',
      type: 'human',
    })
    expect(await loadAgentMemory(db, filesWith({}), humanId)).toBeNull()
  })
})

describe('starterMemoryIndex', () => {
  it('names the agent and explains what the file is for', () => {
    const seed = starterMemoryIndex('scout')
    expect(seed).toContain('@scout')
    expect(seed).toContain('system prompt')
  })
})

/**
 * memory-paths.ts is imported by BROWSER routes (the Crew tab links to an
 * agent's memory in the Files surface), so everything it imports is bundled
 * for the client. Guard the leaf: a server-only import here would put node
 * code in the client bundle (see issues/topic.test.ts for the war story).
 */
describe('memory-paths.ts stays a node-free leaf', () => {
  it('imports nothing server-only', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      fileURLToPath(new URL('./memory-paths.ts', import.meta.url)),
      'utf8',
    )
    expect(src).not.toMatch(/from\s+['"]node:/)
    expect(src).not.toMatch(/from\s+['"][^'"]*pi-/)
    expect(src).not.toMatch(
      /from\s+['"]\.\/(service|server|runtime|memory)['"]/,
    )
  })
})
