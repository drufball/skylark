import type { Database } from '@hull/db/client'
import { FAKE_RUNTIME_ENV } from '@hull/lib/env'
import { liveFilesService } from '@hull/files/live'

import { createFakeSession } from './fake-session'
import { loadAgentMemory, type AgentMemoryLoader } from './memory'
import {
  type AgentRuntime,
  createAgentRuntime,
  createPiSession,
  type SessionFactory,
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
  return (agentUserId) => loadAgentMemory(db, liveFilesService(), agentUserId)
}

/**
 * The runtime every SERVER construction site boots — the agent door and the
 * chat + issue orchestrators. Centralised so the factory choice (live vs fake)
 * has exactly one home and the three sites can't drift. (The CLI builds its own
 * always-live runtime directly; it's interactive and never part of a smoke run.)
 */
export function createServerRuntime(db: Database): AgentRuntime {
  return createAgentRuntime({
    db,
    factory: resolveSessionFactory(),
    memory: liveAgentMemoryLoader(db),
  })
}
