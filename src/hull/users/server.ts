import { uuidv7 } from '@earendil-works/pi-agent-core'
import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { agentMemoryIndexPath, starterMemoryIndex } from '@hull/agent/memory'
import {
  CHAT_PROFILE,
  getProfileById,
  getProfileByName,
} from '@hull/agent/profiles'

import { currentActor } from './actor'
import {
  createUser,
  deleteUser,
  getUserByHandle,
  listUsers,
  updateAgentUser as updateAgentUserRow,
  validateHandle,
} from './service'

// The web doors onto the users service: the crew roster and named-agent
// management (create a new agent crew member, edit an existing one). Creating
// an agent also seeds its persistent memory folder in the shared files —
// agents/<handle>/index.md — which the runtime folds into the agent's system
// prompt at every session boot (see hull/agent/memory.ts).

/** Everyone aboard the ship. */
export const listCrew = createServerFn({ method: 'GET' }).handler(() =>
  listUsers(db),
)

/** Refuse a profile id that points at no profile row (it would break boots). */
async function ensureProfileExists(profileId: string): Promise<string> {
  if (!(await getProfileById(db, profileId))) {
    throw new Error(`No such profile: ${profileId}`)
  }
  return profileId
}

/**
 * Create a named agent: a full crew member (users row, type agent) with a
 * profile and a freshly-seeded memory folder. The seed write is attributed to
 * whoever created the agent. If the seed fails, the user row is rolled back —
 * an agent either exists with its memory folder or not at all, and the handle
 * stays free to retry.
 */
export const createAgentUser = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const record = input as {
      handle?: unknown
      displayName?: unknown
      profileId?: unknown
    }
    if (typeof record.handle !== 'string')
      throw new Error('handle must be a string')
    if (typeof record.displayName !== 'string')
      throw new Error('displayName must be a string')
    return {
      handle: validateHandle(record.handle),
      displayName: record.displayName.trim(),
      profileId:
        typeof record.profileId === 'string' && record.profileId
          ? record.profileId
          : null,
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
    // No profile chosen → the chat profile, NOT the runtime's built-in default
    // (which carries full coding tools — the wrong surprise for a chat agent).
    const profileId = data.profileId
      ? await ensureProfileExists(data.profileId)
      : (await getProfileByName(db, CHAT_PROFILE.name))?.id
    const user = await createUser(db, {
      id: uuidv7(),
      handle: data.handle,
      displayName: data.displayName,
      type: 'agent',
      profileId,
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
 * Edit a named agent's display name and/or profile. Agent-scoped end to end:
 * the service update targets `type = 'agent'`, so a human row reads as
 * not-found no matter what userId a caller supplies.
 */
export const updateAgentUser = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const record = input as {
      userId?: unknown
      displayName?: unknown
      profileId?: unknown
    }
    if (typeof record.userId !== 'string')
      throw new Error('userId must be a string')
    if (
      record.displayName !== undefined &&
      typeof record.displayName !== 'string'
    )
      throw new Error('displayName must be a string')
    if (record.profileId !== undefined && typeof record.profileId !== 'string')
      throw new Error('profileId must be a string')
    return {
      userId: record.userId,
      displayName: record.displayName?.trim(),
      profileId: record.profileId,
    }
  })
  .handler(async ({ data }) => {
    if (data.displayName === '') throw new Error('Display name is required')
    if (data.profileId !== undefined) await ensureProfileExists(data.profileId)
    const row = await updateAgentUserRow(db, data.userId, {
      displayName: data.displayName,
      profileId: data.profileId,
    })
    if (!row) throw new Error('No such agent')
    return row
  })
