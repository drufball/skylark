/**
 * actorCmd: format a CLI command with the SKYLARK_ACTOR prefix for attribution.
 *
 * The actor pattern: when an agent runs a CLI tool (issue, files, etc.), the
 * command includes `SKYLARK_ACTOR=<userId>` so the action attributes to the
 * agent, not the operator. A command-level prefix sets the env for exactly
 * that child process — concurrent agents never race on a shared process env.
 *
 * This helper replaces hand-copied SKYLARK_ACTOR strings across prompts
 * (chat/orchestrator, agent/memory, issues/prompts) with one source of truth.
 */

/**
 * Format a shell command with SKYLARK_ACTOR prefix for agent attribution.
 *
 * @param userId - The agent's user ID (for SKYLARK_ACTOR)
 * @param tool - The npm script name (e.g., 'issue', 'files')
 * @param args - Command arguments (e.g., 'new', '<title>', '--body', '<details>')
 * @returns The formatted command string
 *
 * @example
 * actorCmd('user-123', 'issue', 'new', '"fix bug"', '--body', '"details"')
 * // => 'SKYLARK_ACTOR=user-123 npm run issue -- new "fix bug" --body "details"'
 */
export function actorCmd(
  userId: string,
  tool: string,
  ...args: string[]
): string {
  const argsPart = args.length > 0 ? ` ${args.join(' ')}` : ''
  return `SKYLARK_ACTOR=${userId} npm run ${tool} --${argsPart}`
}
