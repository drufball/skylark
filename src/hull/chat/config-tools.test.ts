import { uuidv7 } from '@earendil-works/pi-agent-core'
import type {
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { asActor, defined, freshDb } from '@hull/db/test-db'
import { createSession } from '@hull/agent/service'
import { getShipDefaultModel } from '@hull/agent/settings'
import { getUserByHandle, seedCrew } from '@hull/users/service'
import { getPlaybookByName, listPlaybooks } from '@hull/issues/playbooks'

import { createConfigSessionTools } from './config-tools'
import { createChat, setMemberSession } from './service'

/**
 * The Config room's tools: `config_playbook`, `config_persona`,
 * `config_model`. Same calling convention as session-tools.test.ts — pi's
 * agent loop calls `tool.execute(id, params, ...)`.
 */

type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>

function call(tool: ToolDefinition, params: unknown): Promise<ToolResult> {
  return tool.execute(
    'call-1',
    params,
    undefined,
    undefined,
    undefined as unknown as ExtensionContext,
  )
}

function resultText(result: ToolResult): string {
  return result.content
    .map((block) => ('text' in block ? block.text : ''))
    .join('')
}

function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
  return defined(tools.find((t) => t.name === name))
}

describe('createConfigSessionTools', () => {
  let db: Database
  let close: () => Promise<void>
  let keelId: string

  let sessionId: string

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    await seedCrew(db)
    keelId = defined(await getUserByHandle(db, 'keel')).id
    const captainId = defined(await getUserByHandle(db, 'captain')).id
    // The Config room itself, by its own well-known chat id — the gate
    // `createConfigSessionTools` checks (findChatForSession + the literal
    // 'room-config' id) before handing out any of these tools.
    await createChat(db, {
      id: 'room-config',
      memberIds: [captainId, keelId],
    })
    sessionId = uuidv7()
    await createSession(db, { id: sessionId, model: 'm', agentUserId: keelId })
    await setMemberSession(db, 'room-config', keelId, sessionId)
  })
  afterEach(() => close())

  function makeTools(): Promise<ToolDefinition[]> {
    return createConfigSessionTools({
      asActor: (actorId, fn) => asActor(db, actorId, fn),
    })({
      sessionId,
      agentUserId: keelId,
      cwd: '/repo',
    })
  }

  it('always offers config_playbook, config_persona, config_model', async () => {
    const tools = await makeTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'config_model',
      'config_persona',
      'config_playbook',
    ])
  })

  describe('config_playbook', () => {
    it('lists every playbook, including the ship default', async () => {
      const tools = await makeTools()
      const result = await call(toolNamed(tools, 'config_playbook'), {
        action: 'list',
      })
      expect(resultText(result)).toMatch(/build/i)
    })

    it('creates a new playbook from a roster of handles', async () => {
      const tools = await makeTools()
      const result = await call(toolNamed(tools, 'config_playbook'), {
        action: 'save',
        name: 'triage',
        description: 'quick look, no build',
        memberHandles: ['tilde', 'bix'],
        entrypointHandle: 'tilde',
      })
      expect(resultText(result)).toMatch(/triage/i)
      const saved = defined(await getPlaybookByName(db, 'triage'))
      expect(saved.description).toBe('quick look, no build')
    })

    it('refuses an unknown handle with a message naming the mistake', async () => {
      const tools = await makeTools()
      await expect(
        call(toolNamed(tools, 'config_playbook'), {
          action: 'save',
          name: 'oops',
          memberHandles: ['nobody'],
          entrypointHandle: 'nobody',
        }),
      ).rejects.toThrow(/nobody/)
    })

    it('updates an existing playbook by name (idempotent upsert)', async () => {
      const tools = await makeTools()
      await call(toolNamed(tools, 'config_playbook'), {
        action: 'save',
        name: 'triage',
        memberHandles: ['tilde'],
        entrypointHandle: 'tilde',
      })
      await call(toolNamed(tools, 'config_playbook'), {
        action: 'save',
        name: 'triage',
        memberHandles: ['tilde', 'bix'],
        entrypointHandle: 'bix',
      })
      const all = await listPlaybooks(db)
      expect(all.filter((p) => p.name === 'triage')).toHaveLength(1)
      const saved = defined(await getPlaybookByName(db, 'triage'))
      expect(saved.entrypointId).toBe(
        defined(await getUserByHandle(db, 'bix')).id,
      )
    })
  })

  describe('config_persona', () => {
    it('creates a new agent persona by handle', async () => {
      const tools = await makeTools()
      const result = await call(toolNamed(tools, 'config_persona'), {
        action: 'create',
        handle: 'scout',
        displayName: 'Scout',
        systemPrompt: 'You scan the horizon for trouble.',
      })
      expect(resultText(result)).toMatch(/scout/i)
      const scout = defined(await getUserByHandle(db, 'scout'))
      expect(scout.type).toBe('agent')
      expect(scout.systemPrompt).toMatch(/horizon/)
    })

    it('edits an existing persona’s prompt', async () => {
      const tools = await makeTools()
      const tilde = defined(await getUserByHandle(db, 'tilde'))
      const result = await call(toolNamed(tools, 'config_persona'), {
        action: 'edit',
        handle: 'tilde',
        systemPrompt: 'You review architecture, sharper now.',
      })
      expect(resultText(result)).toMatch(/tilde/i)
      const after = defined(await getUserByHandle(db, 'tilde'))
      expect(after.id).toBe(tilde.id)
      expect(after.systemPrompt).toBe('You review architecture, sharper now.')
    })

    it('refuses to edit a handle that is not an agent', async () => {
      const tools = await makeTools()
      await expect(
        call(toolNamed(tools, 'config_persona'), {
          action: 'edit',
          handle: 'nobody',
          systemPrompt: 'irrelevant',
        }),
      ).rejects.toThrow(/nobody/i)
    })
  })

  describe('config_model', () => {
    it('reports "no override" when nothing has been set', async () => {
      const tools = await makeTools()
      const result = await call(toolNamed(tools, 'config_model'), {
        action: 'get',
      })
      expect(resultText(result)).toMatch(/no override/i)
    })

    it('sets the ship default model override', async () => {
      const tools = await makeTools()
      const result = await call(toolNamed(tools, 'config_model'), {
        action: 'set',
        model: 'claude-opus-4-5',
      })
      expect(resultText(result)).toMatch(/claude-opus-4-5/)
      expect(await getShipDefaultModel(db)).toBe('claude-opus-4-5')
    })

    it('clears the override back to the env default', async () => {
      const tools = await makeTools()
      await call(toolNamed(tools, 'config_model'), {
        action: 'set',
        model: 'claude-opus-4-5',
      })
      const result = await call(toolNamed(tools, 'config_model'), {
        action: 'clear',
      })
      expect(resultText(result)).toMatch(/clear/i)
      expect(await getShipDefaultModel(db)).toBeNull()
    })
  })

  it('gives no tools to a session with no agent (unattributed)', async () => {
    const tools = await createConfigSessionTools({
      asActor: (actorId, fn) => asActor(db, actorId, fn),
    })({
      sessionId: 'sess-2',
      agentUserId: null,
      cwd: '/repo',
    })
    expect(tools).toEqual([])
  })

  it('gives no tools to an agent session that backs some OTHER chat', async () => {
    const otherSession = uuidv7()
    await createSession(db, {
      id: otherSession,
      model: 'm',
      agentUserId: keelId,
    })
    const captainId = defined(await getUserByHandle(db, 'captain')).id
    const otherChat = uuidv7()
    await createChat(db, { id: otherChat, memberIds: [captainId, keelId] })
    await setMemberSession(db, otherChat, keelId, otherSession)
    const tools = await createConfigSessionTools({
      asActor: (actorId, fn) => asActor(db, actorId, fn),
    })({
      sessionId: otherSession,
      agentUserId: keelId,
      cwd: '/repo',
    })
    expect(tools).toEqual([])
  })
})
