import type { Database } from '@hull/db/client'
import { getUserById } from '@hull/users/service'

import { agentMemoryDir, agentMemoryIndexPath } from './memory-paths'
import type { ResolvedProfile } from './session-config'

/**
 * Persistent memory for named agents. Every agent crew member owns a folder in
 * the ship's shared files — `agents/<handle>/` — that survives across sessions.
 * At session boot the runtime loads the folder's index file and folds it into
 * the system prompt, so the agent starts every session knowing what it knows;
 * the agent updates its own memory through the files CLI, attributed as itself.
 *
 * The prompt composition (`withAgentMemory`) is pure; `loadAgentMemory` reads
 * through an injected file reader so it tests without a git repo. The path
 * constants live in memory-paths.ts (a node-free leaf the browser can import)
 * and are re-exported here for server-side callers.
 */

export {
  agentMemoryDir,
  agentMemoryIndexPath,
  starterMemoryIndex,
} from './memory-paths'

/** What the runtime loads for a session's agent identity at boot. */
export interface AgentMemory {
  userId: string
  handle: string
  /** The memory index's content, or null when it doesn't exist yet. */
  index: string | null
}

/** How the runtime loads memory for a session's agentUserId (null: no agent). */
export type AgentMemoryLoader = (
  agentUserId: string,
) => Promise<AgentMemory | null>

/**
 * Fold an agent's persistent memory into the profile it boots with: identity,
 * where the memory lives, the index's contents, and how to update it. Appended
 * after the profile's own system prompt so the profile still leads.
 */
export function withAgentMemory(
  profile: ResolvedProfile,
  memory: AgentMemory,
): ResolvedProfile {
  const dir = agentMemoryDir(memory.handle)
  const indexPath = agentMemoryIndexPath(memory.handle)
  const index =
    memory.index === null || memory.index.trim() === ''
      ? '(your index is empty — write one as you learn)'
      : memory.index.trim()

  const preamble = `You are @${memory.handle}, a named member of this ship's crew.

Your persistent memory lives in the ship's shared files under ${dir}/ and
survives across sessions. Your memory index (${indexPath}) follows:

${index}

To read or update your memory, use bash (writes attribute to you):
  SKYLARK_ACTOR=${memory.userId} npm run files -- read ${dir}/<file>
  SKYLARK_ACTOR=${memory.userId} npm run files -- write ${dir}/<file> --stdin

Keep ${indexPath} current: it is loaded into your system prompt at the start
of every session, so it should orient a fresh you.`

  return {
    ...profile,
    systemPrompt: profile.systemPrompt
      ? `${profile.systemPrompt}\n\n${preamble}`
      : preamble,
  }
}

/** The slice of the files service memory loading needs. */
export interface ReadsFiles {
  read(path: string): Promise<string | null>
}

/**
 * Load a session's agent memory: resolve the agent user, read its index from
 * the shared files. Null when the user doesn't exist or isn't an agent (a
 * human-attributed session gets no memory preamble).
 */
export async function loadAgentMemory(
  db: Database,
  files: ReadsFiles,
  agentUserId: string,
): Promise<AgentMemory | null> {
  const user = await getUserById(db, agentUserId)
  if (user?.type !== 'agent') return null
  const index = await files.read(agentMemoryIndexPath(user.handle))
  return { userId: user.id, handle: user.handle, index }
}
