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
 * (`echo "commit"`, `git-committer.txt`) does not. Global options between
 * `git` and the verb (`git -c user.name=x commit`, `git -C /repo add`) are
 * skipped — each `-flag` may carry one value token, where a token may span
 * quoted whitespace (`-c user.name="a b"`) — so a dressed-up commit can't
 * slip past the gate.
 *
 * Keep this regex in sync with scripts/commit-gate, the human-side hook that
 * runs the same match via `node -e`.
 */
export function isCommitCommand(command: string): boolean {
  return /\bgit(?:\s+-\S+(?:\s+(?!-)(?:[^\s"']|"[^"]*"|'[^']*')+)?)*\s+(add|commit)\b/.test(
    command,
  )
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

/**
 * The landing gate's whole decision: warn when `git log @{u}..HEAD` failed
 * (a nonzero — or never-assigned — exit code usually means no upstream is
 * set, i.e. the branch was never pushed) OR when it listed commits ahead of
 * the upstream. Zero exit + empty output is the only quiet path.
 */
export function shouldWarnUnpushed(
  code: number | null,
  stdout: string,
): boolean {
  return code !== 0 || hasUnpushedCommits(stdout)
}
