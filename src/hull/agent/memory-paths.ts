/**
 * Where a named agent's persistent memory lives in the ship's shared files —
 * the one piece of the memory contract the BROWSER needs (the Crew tab links
 * to an agent's memory in the Files surface). A node-free leaf, like
 * issues/topic.ts: routes import the paths from here without dragging the
 * memory loader's server-only imports into the client bundle.
 */

/** The shared-files folder a named agent's memory lives in. */
export function agentMemoryDir(handle: string): string {
  return `agents/${handle}`
}

/** The index file loaded into the agent's system prompt at session boot. */
export function agentMemoryIndexPath(handle: string): string {
  return `${agentMemoryDir(handle)}/index.md`
}

/** The seed content a fresh named agent's index starts with. */
export function starterMemoryIndex(handle: string): string {
  return `# @${handle}'s memory

Nothing here yet. This file is loaded into @${handle}'s system prompt at the
start of every session — durable facts, pointers to other files in this
folder, and ongoing work belong here.
`
}
