import type { Database } from '@hull/db/client'
import { FAKE_RUNTIME_ENV } from '@hull/lib/env'

import { createFakeSession } from './fake-session'
import { loadAgentMemory, type AgentMemoryLoader } from './memory'
import {
  type AgentRuntime,
  createAgentRuntime,
  createPiSession,
  type SessionFactory,
  type SessionToolsProvider,
} from './runtime'

/**
 * The session factory the server should use: the live pi.dev wiring, or the
 * deterministic fake when `SKYLARK_FAKE_RUNTIME` is set.
 */
export function resolveSessionFactory(): SessionFactory {
  return process.env[FAKE_RUNTIME_ENV] ? createFakeSession : createPiSession
}

/**
 * The memory loader every live runtime uses: a named agent's index is read
 * through the files service (so it sees the staged state like everyone else).
 */
export function liveAgentMemoryLoader(db: Database): AgentMemoryLoader {
  return async (agentUserId) => {
    const { liveFilesService } = await import('@hull/files/live')
    return loadAgentMemory(db, liveFilesService(), agentUserId)
  }
}

/**
 * The runtime every SERVER construction site boots — the agent door and the
 * chat + issue orchestrators. Centralised so the factory choice (live vs fake)
 * has exactly one home and the three sites can't drift. (The CLI builds its own
 * always-live runtime directly; it's interactive and never part of a smoke run.)
 *
 * `sessionTools` is the host's chance to contribute tools of its own — the chat
 * orchestrator passes `createChatSessionTools`, which is how an agent gets a
 * `chat_post` door on the session that speaks for a chat. Passed in rather than
 * imported here so the agent service keeps knowing nothing about chat.
 */
export function createServerRuntime(
  db: Database,
  sessionTools?: SessionToolsProvider,
): AgentRuntime {
  return createAgentRuntime({
    db,
    factory: resolveSessionFactory(),
    memory: liveAgentMemoryLoader(db),
    sessionTools,
  })
}
