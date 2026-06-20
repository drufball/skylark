import { truncate } from '@hull/lib/text'

/**
 * The pure decision logic behind the build-gates extension, kept apart from the
 * pi.dev wiring (index.ts) so it can be unit-tested without a live agent. The
 * extension's job is to mirror the human's Claude Code hooks for builder
 * agents: don't commit until `npm run check` passes, don't end a session with
 * unpushed commits, and set up a fresh worktree on session start. These
 * functions answer the yes/no questions that drive those gates.
 */

/**
 * Does this bash command commit (or stage) work? We block on `git add` and
 * `git commit` so the check runs before either — matching the human's
 * commit-gate, which fires before `git add`/`git commit`.
 *
 * Matched on word boundaries so a `git` subcommand anywhere in a compound
 * command (`cd x && git commit`) counts, while a mere mention
 * (`echo "commit"`, `git-committer.txt`) does not.
 */
export function isCommitCommand(command: string): boolean {
  return /\bgit\s+(add|commit)\b/.test(command)
}

/** Did `npm run check` pass? Zero exit code only. */
export function checkPassed(exitCode: number): boolean {
  return exitCode === 0
}

/** The message shown when a commit is blocked, carrying the tail of check output. */
export function blockReason(command: string, output: string): string {
  const tail = truncate(output.trim(), 2000)
  return `Blocked: \`${command}\` — \`npm run check\` failed. Fix it before committing.\n\n${tail}`
}

/**
 * Does the output of `git log @{u}..HEAD --oneline` indicate unpushed commits?
 * One line per commit ahead of the upstream; empty (or whitespace) means the
 * branch is pushed. Used by the landing gate at session end.
 */
export function hasUnpushedCommits(gitLogOutput: string): boolean {
  return gitLogOutput.trim().length > 0
}
