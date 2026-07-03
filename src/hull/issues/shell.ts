/**
 * Quote a shell argument (paths/branches) safely for exec: wrap in single
 * quotes, escaping any embedded single quote as `'\''` (close the span, emit a
 * literal quote, reopen). Single quotes suppress every expansion — `$(…)`,
 * backticks, `$VAR` — so whatever the argument carries arrives verbatim.
 *
 * This feeds the orchestrator's real `git worktree add` / `gh pr list` exec
 * calls (orchestrator-live.ts), where branch names include an LLM-suggested
 * slug — quoting is the security boundary, so it lives here, tested.
 */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
