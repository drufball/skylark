import { uuidv7 } from '@earendil-works/pi-agent-core'
import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { agentMemoryIndexPath, starterMemoryIndex } from '@hull/agent/memory'
import { CHAT_CONFIG } from '@hull/agent/agent-config'

import { currentActor } from './actor'
import {
  createUser,
  deleteUser,
  getUserByHandle,
  listUsers,
  updateAgentUser as updateAgentUserRow,
  validateHandle,
  type AgentConfigFields,
} from './service'

// The web doors onto the users service: the crew roster and named-agent
// management (create a new agent crew member, edit an existing one). Creating
// an agent also seeds its persistent memory folder in the shared files —
// agents/<handle>/index.md — which the runtime folds into the agent's system
// prompt at every session boot (see hull/agent/memory.ts). An agent's config
// (system prompt, tools, context/skills, extensions, model) rides directly on
// its users row — there's no separate profile to look up.

/** Everyone aboard the ship. */
export const listCrew = createServerFn({ method: 'GET' }).handler(() =>
  listUsers(db),
)

/** The untrusted shape of an agent-config payload from the client. */
interface AgentConfigPayload {
  systemPrompt?: unknown
  tools?: unknown
  readContextFiles?: unknown
  useRepoSkills?: unknown
  extensionIds?: unknown
  model?: unknown
}

/**
 * Narrow + normalize an untrusted agent-config payload. Every field is
 * optional (undefined leaves it alone on update); a field that IS present
 * must have the right shape, or we throw a message meant for whoever's
 * driving the form. Blank text / an empty tool list fold to null, so a
 * cleared field reads as "use the default", not "an empty string/list".
 */
function validateAgentConfig(input: AgentConfigPayload): AgentConfigFields {
  const fields: AgentConfigFields = {}
  if (input.systemPrompt !== undefined) {
    if (input.systemPrompt !== null && typeof input.systemPrompt !== 'string')
      throw new Error('systemPrompt must be a string or null')
    fields.systemPrompt = input.systemPrompt?.trim() ? input.systemPrompt : null
  }
  if (input.tools !== undefined) {
    if (
      input.tools !== null &&
      !(
        Array.isArray(input.tools) &&
        input.tools.every((t) => typeof t === 'string')
      )
    )
      throw new Error('tools must be a list of strings or null')
    fields.tools = input.tools && input.tools.length > 0 ? input.tools : null
  }
  if (input.readContextFiles !== undefined) {
    if (typeof input.readContextFiles !== 'boolean')
      throw new Error('readContextFiles must be a boolean')
    fields.readContextFiles = input.readContextFiles
  }
  if (input.useRepoSkills !== undefined) {
    if (typeof input.useRepoSkills !== 'boolean')
      throw new Error('useRepoSkills must be a boolean')
    fields.useRepoSkills = input.useRepoSkills
  }
  if (input.extensionIds !== undefined) {
    if (
      !Array.isArray(input.extensionIds) ||
      !input.extensionIds.every((id) => typeof id === 'string')
    )
      throw new Error('extensionIds must be a list of strings')
    fields.extensionIds = input.extensionIds
  }
  if (input.model !== undefined) {
    if (input.model !== null && typeof input.model !== 'string')
      throw new Error('model must be a string or null')
    fields.model = input.model?.trim() ? input.model : null
  }
  return fields
}

/**
 * Create a named agent: a full crew member (users row, type agent) with its
 * own config and a freshly-seeded memory folder. The seed write is attributed
 * to whoever created the agent. If the seed fails, the user row is rolled
 * back — an agent either exists with its memory folder or not at all, and the
 * handle stays free to retry.
 */
export const createAgentUser = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const record = input as {
      handle?: unknown
      displayName?: unknown
    } & AgentConfigPayload
    if (typeof record.handle !== 'string')
      throw new Error('handle must be a string')
    if (typeof record.displayName !== 'string')
      throw new Error('displayName must be a string')
    return {
      handle: validateHandle(record.handle),
      displayName: record.displayName.trim(),
      config: validateAgentConfig(record),
    }
  })
  .handler(async ({ data }) => {
    if (!data.displayName) throw new Error('Display name is required')
    // Resolve the acting user BEFORE any mutation, so a failed actor
    // resolution can't leave a half-made agent behind.
    const actor = await currentActor()
    if (await getUserByHandle(db, data.handle)) {
      throw new Error(`Handle @${data.handle} is taken`)
    }
    // No config chosen → the chat pilot, NOT the schema's bare defaults
    // (which read as a full builder: every tool, CLAUDE.md, repo skills) —
    // the wrong surprise for a freshly-created conversational agent.
    const user = await createUser(db, {
      id: uuidv7(),
      handle: data.handle,
      displayName: data.displayName,
      type: 'agent',
      ...CHAT_CONFIG,
      extensionIds: [],
      ...data.config,
    })
    try {
      const { liveFilesService } = await import('@hull/files/live')
      await liveFilesService().write({
        path: agentMemoryIndexPath(user.handle),
        content: starterMemoryIndex(user.handle),
        actor: { id: actor.id, handle: actor.handle },
      })
    } catch (err) {
      // Compensate: no agent without its memory folder, and the handle stays
      // free so the creation can simply be retried.
      await deleteUser(db, user.id)
      throw err
    }
    return user
  })

/**
 * Edit a named agent's display name and/or config. Agent-scoped end to end:
 * the service update targets `type = 'agent'`, so a human row reads as
 * not-found no matter what userId a caller supplies.
 */
export const updateAgentUser = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const record = input as {
      userId?: unknown
      displayName?: unknown
    } & AgentConfigPayload
    if (typeof record.userId !== 'string')
      throw new Error('userId must be a string')
    if (
      record.displayName !== undefined &&
      typeof record.displayName !== 'string'
    )
      throw new Error('displayName must be a string')
    return {
      userId: record.userId,
      displayName: record.displayName?.trim(),
      config: validateAgentConfig(record),
    }
  })
  .handler(async ({ data }) => {
    if (data.displayName === '') throw new Error('Display name is required')
    const row = await updateAgentUserRow(db, data.userId, {
      displayName: data.displayName,
      ...data.config,
    })
    if (!row) throw new Error('No such agent')
    return row
  })
