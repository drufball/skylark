import { and, eq, ne } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import { runningSessionIds } from '@hull/agent/service'
import { emitEvent } from '@hull/events/bus'
import { PUBLIC_AUDIENCE } from '@hull/events/service'
import { getUserByHandle, handleOf } from '@hull/users/service'

import { issueSessions, type IssueRow } from './schema'
import { issueTopic } from './topic'
import { playbookFor } from './playbooks'
import { resolveIssueRef } from './service'

/**
 * The baton: how one agent hands an issue's work to another. A handoff is a
 * durable `issue.handoff` event on the issue's topic — the same door-agnostic,
 * cross-process route every transition takes. The server-side orchestrator
 * hears it and drives a turn for the target agent IN THE SAME WORKTREE (one
 * worktree per issue, always); the notifications reactor fans it out so
 * watchers see the baton move.
 *
 * `OWNER` is the escape hatch: instead of driving another worktree session, it
 * pings whoever answers for the issue (issues.ownerId) through their inbox —
 * a human reads it there; an agent owner is woken by the agent waker. Use it
 * when the work needs a decision, a review, or an opinion the playbook's
 * agents can't supply.
 *
 * One baton per issue: a handoff is refused while another agent's session on
 * the issue is mid-turn. The CALLER being mid-turn is expected — an agent
 * hands off from inside its own turn, as its last action.
 */

/** Event type for a baton pass, on topic `issue:<id>`, audience public. */
export const ISSUE_HANDOFF = 'issue.handoff'

/** The special target that pings the issue's owner instead of an agent. */
const OWNER_TARGET = 'OWNER'

/** What an `issue.handoff` event carries on the ship's log. */
export interface IssueHandoffPayload {
  issueId: string
  fromUserId: string
  toUserId: string
  /** The target's handle, carried so inbox copy needs no lookup. */
  toHandle: string
  /** True for an OWNER ping (inbox/wake), false for a baton pass (a turn). */
  toOwner: boolean
  message: string
}

/** A refused handoff — bad target, wrong state, or the baton is taken. */
class HandoffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HandoffError'
  }
}

/**
 * Agents (other than the caller) currently mid-turn on this issue. Checked at
 * the door by requestHandoff and AGAIN by the orchestrator inside its per-issue
 * chain (applyHandoff) — the door check gives the agent a good error, the
 * serialized re-check is the one that's actually atomic against a racing pass.
 */
export async function runningHands(
  db: Database,
  issueId: string,
  exceptUserId: string,
): Promise<string[]> {
  // Two questions, two owners: this service knows which sessions hang off the
  // issue (its own issue_sessions links); the agent service answers which of
  // those are mid-turn — without issues ever reading the sessions table.
  const links = await db
    .select({
      agentUserId: issueSessions.agentUserId,
      sessionId: issueSessions.sessionId,
    })
    .from(issueSessions)
    .where(
      and(
        eq(issueSessions.issueId, issueId),
        ne(issueSessions.agentUserId, exceptUserId),
      ),
    )
  const running = new Set(
    await runningSessionIds(
      db,
      links.map((l) => l.sessionId),
    ),
  )
  return links.filter((l) => running.has(l.sessionId)).map((l) => l.agentUserId)
}

/**
 * Validate a handoff and announce it on the ship's log. Throws HandoffError
 * (with a message meant for the agent that typed the command) before any emit,
 * so a refused handoff leaves no trace. Returns what the CLI echoes.
 */
export async function requestHandoff(
  db: Database,
  input: {
    issueRef: string
    actorId: string
    /** A crew agent's handle (with or without @), or OWNER. */
    target: string
    message: string
  },
): Promise<{ issue: IssueRow; toHandle: string; toOwner: boolean }> {
  const issue = await resolveIssueRef(db, input.issueRef)
  if (!issue) throw new HandoffError(`No such issue: ${input.issueRef}`)

  const message = input.message.trim()
  if (!message) {
    throw new HandoffError(
      'A handoff needs a message — say what you did and what is needed next.',
    )
  }

  const toOwner = input.target.toUpperCase() === OWNER_TARGET
  let toUserId: string
  let toHandle: string
  if (toOwner) {
    // An owner ping needs no worktree and no state check — asking the person
    // (or agent) who answers for the issue is always legal. Unless YOU are the
    // owner: your own action is never your own news (the reactor skips the
    // actor), so a self-ping would vanish silently and strand the issue.
    if (issue.ownerId === input.actorId) {
      throw new HandoffError(
        'You are the owner of this issue — pinging yourself goes nowhere. ' +
          `Post your question as a comment and pause instead: ` +
          `issue comment ${issue.nano} "<question>" then issue open ${issue.nano}.`,
      )
    }
    toUserId = issue.ownerId
    toHandle = await handleOf(db, issue.ownerId)
  } else {
    const handle = input.target.replace(/^@/, '')
    const target = await getUserByHandle(db, handle)
    if (!target) throw new HandoffError(`No such crew member: @${handle}`)
    if (target.type !== 'agent') {
      throw new HandoffError(
        `@${handle} is human — the baton only passes between agents. ` +
          'Use OWNER to ask the issue owner for a decision.',
      )
    }
    if (target.id === input.actorId) {
      throw new HandoffError('You cannot hand the baton to yourself.')
    }
    // The playbook is the roster: the baton only passes between the agents an
    // issue was set up with. OWNER (above) is the deliberate exception — the
    // escape hatch out of the roster when the work needs a decision.
    const playbook = await playbookFor(db, issue)
    if (playbook && !playbook.memberIds.includes(target.id)) {
      const handles = await Promise.all(
        playbook.memberIds.map((id) => handleOf(db, id)),
      )
      throw new HandoffError(
        `@${handle} is not on this issue's playbook "${playbook.name}" ` +
          `(members: @${handles.join(', @')}). Hand to a member, or use ` +
          'OWNER to escalate.',
      )
    }
    if (issue.status !== 'building') {
      throw new HandoffError(
        `Issue #${issue.nano} is ${issue.status}, not building — there is no ` +
          'worktree to hand over. Start it first.',
      )
    }
    const busy = await runningHands(db, issue.id, input.actorId)
    if (busy.length > 0) {
      const handles = await Promise.all(busy.map((id) => handleOf(db, id)))
      throw new HandoffError(
        `The baton is taken: @${handles.join(', @')} is mid-turn on ` +
          `#${issue.nano}. Wait for their turn to end.`,
      )
    }
    toUserId = target.id
    toHandle = target.handle
  }

  const payload: IssueHandoffPayload = {
    issueId: issue.id,
    fromUserId: input.actorId,
    toUserId,
    toHandle,
    toOwner,
    message,
  }
  await emitEvent(db, {
    type: ISSUE_HANDOFF,
    source: 'issues',
    topic: issueTopic(issue.id),
    audience: PUBLIC_AUDIENCE,
    actorId: input.actorId,
    payload,
  })
  return { issue, toHandle, toOwner }
}
