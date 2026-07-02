import { uuidv7 } from '@earendil-works/pi-agent-core'
import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { agentMemoryIndexPath, starterMemoryIndex } from '@hull/agent/memory'
import { CHAT_PROFILE, getProfileByName } from '@hull/agent/profiles'
import { liveFilesService } from '@hull/files/live'

import { currentActor } from './actor'
import {
  createUser,
  getUserByHandle,
  listUsers,
  updateUser,
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

/**
 * Create a named agent: a full crew member (users row, type agent) with a
 * profile and a freshly-seeded memory folder. The seed write is attributed to
 * whoever created the agent.
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
    if (await getUserByHandle(db, data.handle)) {
      throw new Error(`Handle @${data.handle} is taken`)
    }
    // No profile chosen → the chat profile, NOT the runtime's built-in default
    // (which carries full coding tools — the wrong surprise for a chat agent).
    const profileId =
      data.profileId ??
      (await getProfileByName(db, CHAT_PROFILE.name))?.id ??
      undefined
    const user = await createUser(db, {
      id: uuidv7(),
      handle: data.handle,
      displayName: data.displayName,
      type: 'agent',
      profileId,
    })
    const actor = await currentActor()
    await liveFilesService().write({
      path: agentMemoryIndexPath(user.handle),
      content: starterMemoryIndex(user.handle),
      actor: { id: actor.id, handle: actor.handle },
    })
    return user
  })

/** Edit a named agent's display name and/or profile. */
export const updateCrewMember = createServerFn({ method: 'POST' })
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
    const row = await updateUser(db, data.userId, {
      displayName: data.displayName,
      profileId: data.profileId,
    })
    if (!row) throw new Error('No such crew member')
    return row
  })
