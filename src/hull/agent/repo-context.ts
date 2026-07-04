import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// What the agent shares with the rest of the ship: the same CLAUDE.md and the
// same skills the human's Claude Code session uses. These helpers resolve those
// from the repo so the pi.dev runtime can feed them to the agent — config lives
// in one place, read by both.

/**
 * Context files to put in front of the agent. Today that's CLAUDE.md (pi.dev's
 * own convention is AGENTS.md, which we don't use), returned in pi's
 * agents-file shape. Empty if the repo has none.
 */
export function readContextFiles(
  cwd: string,
): { path: string; content: string }[] {
  const claudeMd = join(cwd, 'CLAUDE.md')
  if (!existsSync(claudeMd)) return []
  return [{ path: claudeMd, content: readFileSync(claudeMd, 'utf8') }]
}

/**
 * Skill directories to hand pi.dev for discovery: the ship-level skills and the
 * service-tree skills. Only those that exist — pi tolerates missing paths, but
 * filtering keeps the diagnostics quiet. pi walks each dir for SKILL.md roots.
 */
export function skillDirs(cwd: string): string[] {
  return [join(cwd, '.claude/skills'), join(cwd, 'src/.claude/skills')].filter(
    (dir) => existsSync(dir),
  )
}
