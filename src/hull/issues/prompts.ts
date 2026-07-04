import { actorCmd } from '@hull/lib/actor-cmd'

import type { IssueRow } from './schema'

/**
 * Issue prompts: pure builders for seeding/resuming agent sessions on issues.
 *
 * Extracted from orchestrator.ts (~150 lines) to keep the orchestrator lean
 * and the wording reviewable + testable without booting an agent. Three
 * prompts cover the lifecycle: buildPrompt (ship-feature contract),
 * generalPrompt (plain "do what it says"), and handoffPrompt (baton pass).
 *
 * The threadBlock and actorCmd helpers eliminate duplication across chat,
 * agent/memory, and issues — the thread format and the SKYLARK_ACTOR command
 * prefix were hand-copied in 5+ places and drifting.
 */

/**
 * Format a comment thread as a prompt block: `\n\nThread so far:\n` plus one
 * line per comment (`- @handle: body`), or an empty string when the thread is
 * empty. The `\n\n` lead-in separates it from the title/body above; the
 * shared format keeps the thread readable across all prompt sites.
 */
export function threadBlock(
  comments: { authorHandle: string; body: string }[],
): string {
  if (comments.length === 0) return ''
  return (
    '\n\nThread so far:\n' +
    comments.map((c) => `- @${c.authorHandle}: ${c.body}`).join('\n')
  )
}

/**
 * The prompt a builder session is seeded with: the issue (title, body, the
 * thread so far) plus the contract for reporting back through the issue CLI.
 * Pure so the wording is reviewable and testable without booting an agent.
 *
 * The babysitter handle is now a parameter (not hardcoded) so renaming the
 * crew's babysitter doesn't break the handoff instruction — the orchestrator
 * resolves it from the playbook roster, and requestHandoff validates it.
 */
export function buildPrompt(
  issue: IssueRow,
  comments: { authorHandle: string; body: string }[],
  /**
   * The builder's user id, prefixed onto the issue CLI commands as
   * `SKYLARK_ACTOR=<id>` so the agent's comments and transitions attribute to
   * the builder. A command-level prefix sets the env for exactly that child
   * process, so concurrent builders never race on a shared process env.
   */
  builderUserId: string,
  /**
   * The handle of the agent who shepherds PRs (looked up from the playbook
   * roster, not hardcoded — renaming the babysitter no longer breaks the
   * handoff instruction).
   */
  babysitterHandle: string,
): string {
  const thread = threadBlock(comments)
  const issueCmd = actorCmd(builderUserId, 'issue')
  return (
    `Build this issue (#${issue.nano}).\n\n` +
    `Title: ${issue.title}\n` +
    (issue.body ? `\n${issue.body}\n` : '') +
    thread +
    '\n\nFollow the ship-feature skill through OPENING the PR: red-green TDD, ' +
    '`npm run check` clean, branch, push, open a PR. You are already on the ' +
    'issue branch in a dedicated worktree. Shepherding CI and merging is the ' +
    `${babysitterHandle}'s job, not yours.\n\n` +
    'Report back through the issue CLI. Always run it with the actor prefix shown ' +
    'so your comments and transitions are attributed to you:\n' +
    `- Once the PR is open, hand the baton as your LAST action and stop: ` +
    `${issueCmd} handoff ${issue.nano} ${babysitterHandle} "PR #<n> open — <what it does>"\n` +
    `- If you need clarification, post it and pause: ${issueCmd} comment ${issue.nano} "<question>" ` +
    `then ${issueCmd} open ${issue.nano}, then stop and wait.\n` +
    `- If you are stuck or the work needs a decision, ask the issue's owner as ` +
    `your LAST action and stop: ${issueCmd} handoff ${issue.nano} OWNER "<what you did, what you need>"\n`
  )
}

/**
 * The prompt a non-build playbook's entrypoint is seeded with: the issue and
 * thread, plus the plain CLI contract — comment, hand off (roster or OWNER),
 * pause, done. No ship-feature script, no PR talk: the issue's own words are
 * the instructions. Pure, so the wording is testable.
 */
export function generalPrompt(
  issue: IssueRow,
  comments: { authorHandle: string; body: string }[],
  /** The entrypoint agent's user id, for the SKYLARK_ACTOR command prefix. */
  entryUserId: string,
): string {
  const thread = threadBlock(comments)
  const issueCmd = actorCmd(entryUserId, 'issue')
  return (
    `Work this issue (#${issue.nano}).\n\n` +
    `Title: ${issue.title}\n` +
    (issue.body ? `\n${issue.body}\n` : '') +
    thread +
    '\n\nYou are in a dedicated worktree for this issue. The issue itself is ' +
    'your brief — do what it asks.\n\n' +
    'Report back through the issue CLI. Always run it with the actor prefix ' +
    'shown so your work is attributed to you:\n' +
    `- Post progress or findings: ${issueCmd} comment ${issue.nano} "<text>"\n` +
    `- Pass work to another agent on this issue's playbook, as your LAST action: ` +
    `${issueCmd} handoff ${issue.nano} <agent-handle> "<message>"\n` +
    `- Ask the issue's owner for a decision or review (also a last action): ` +
    `${issueCmd} handoff ${issue.nano} OWNER "<message>"\n` +
    `- If you need clarification, post it and pause: ${issueCmd} comment ${issue.nano} "<question>" ` +
    `then ${issueCmd} open ${issue.nano}, then stop and wait.\n` +
    `- When the work is complete, run: ${issueCmd} done ${issue.nano}\n`
  )
}

/**
 * The prompt a baton pass seeds/resumes the target agent's session with: who
 * handed it over and why, plus the same actor-prefixed CLI contract the builder
 * gets — the target reports back (and hands off further) as ITSELF. The full
 * thread is deliberately not folded in: the handoff message is the brief, and
 * `issue show` is one command away. Pure, so the wording is testable.
 */
export function handoffPrompt(
  issue: IssueRow,
  fromHandle: string,
  message: string,
  toUserId: string,
): string {
  const issueCmd = actorCmd(toUserId, 'issue')
  return (
    `@${fromHandle} handed you issue #${issue.nano}.\n\n` +
    `Title: ${issue.title}\n\n` +
    `Their message:\n${message}\n\n` +
    'You are in the issue worktree, shared by every agent on this issue. ' +
    `Read the full thread with: ${issueCmd} show ${issue.nano}\n\n` +
    'Do your part, then report back through the issue CLI. Always run it with ' +
    'the actor prefix shown so your work is attributed to you:\n' +
    `- Post progress or findings: ${issueCmd} comment ${issue.nano} "<text>"\n` +
    `- Pass the baton onward as your LAST action, then stop: ` +
    `${issueCmd} handoff ${issue.nano} <agent-handle> "<what you did, what is needed next>"\n` +
    `- Ask the issue's owner for a decision or review (also a last action): ` +
    `${issueCmd} handoff ${issue.nano} OWNER "<message>"\n` +
    // "Complete", not "merged": the baton crosses playbooks, and on a general
    // issue done ≠ a PR. The done-teardown's merge check guards code work.
    // LAST action: done tears down every session on the issue, including the
    // one running this very turn — the ending must be chosen, not a surprise.
    `- When the issue's work is complete, run ${issueCmd} done ${issue.nano} ` +
    `as your LAST action, then stop.\n`
  )
}
