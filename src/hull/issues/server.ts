import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { listEventsSince, PUBLIC_AUDIENCE } from '@hull/events/service'
import { currentActor } from '@hull/users/actor'
import { handleOf } from '@hull/users/service'
import {
  BUILD_PLAYBOOK_NAME,
  listPlaybooks,
  requirePlaybook,
  seedPlaybooks,
  upsertPlaybook,
  validatePlaybookInput,
} from './playbooks'
import {
  addComment,
  assembleThread,
  createIssue,
  getIssue,
  ISSUE_STATUS_CHANGED,
  issueTopic,
  listComments,
  listIssues,
  toBoardCard,
  transitionIssue,
  validateCommentInput,
  validateOpenIssueInput,
  validateTransitionInput,
  type IssueStatusChangedPayload,
  type IssueThread,
  type StatusChange,
} from './service'

// The web doors onto the issues service — the message board. Issues are created
// by currentActor() (the operator) and comments by the current actor, so the UI
// never has to ask "who are you". The pure shaping (board cards, the merged
// thread timeline) lives in service.ts and is PGlite-tested; these doors only
// gather rows and call it.
//
// A transition does NOT drive the orchestrator inline — it emits on the ship's
// log, and the orchestrator (subscribed via ensureOrchestrator) reacts off the
// bus. That's deliberate: the same path serves an agent's CLI transition from a
// separate process. These doors only ensure the subscription is live.

export type { BoardIssue, IssueThread, ThreadEntry } from './service'

/** Ensure the orchestrator is booted + subscribed in this server process. */
function bootOrchestrator(): void {
  // Lazy import orchestrator to keep node builtins out of client bundle
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ensureOrchestrator } = require('./orchestrator-live') as {
    ensureOrchestrator: () => Promise<unknown>
  }
  void ensureOrchestrator().catch((err: unknown) => {
    console.error(`orchestrator boot failed: ${String(err)}`)
  })
}

/** All issues as board cards, newest first. The board groups by status itself. */
export const listBoard = createServerFn({ method: 'GET' }).handler(async () => {
  bootOrchestrator()
  const issues = await listIssues(db)
  return Promise.all(
    issues.map(async (issue) =>
      toBoardCard(
        issue,
        await handleOf(db, issue.authorId),
        (await listComments(db, issue.id)).length,
      ),
    ),
  )
})

/**
 * An issue with its full thread: comments and status-change entries merged and
 * sorted by time. The status entries come from the ship's log on the issue's
 * scope — the durable record of who moved it and when. Shaping is the pure
 * `assembleThread`; this door just gathers the rows and resolves handles.
 */
export const getThread = createServerFn({ method: 'GET' })
  .validator((issueId: string) => issueId)
  .handler(async ({ data: issueId }): Promise<IssueThread | null> => {
    bootOrchestrator()
    const issue = await getIssue(db, issueId)
    if (!issue) return null

    const comments = await Promise.all(
      (await listComments(db, issueId)).map(async (c) => ({
        id: c.id,
        authorHandle: await handleOf(db, c.authorId),
        body: c.body,
        at: c.createdAt.toISOString(),
      })),
    )

    const events = await listEventsSince(db, {
      topicPatterns: [issueTopic(issueId)],
      audience: PUBLIC_AUDIENCE,
    })
    const statusChanges: StatusChange[] = await Promise.all(
      events
        .filter((e) => e.type === ISSUE_STATUS_CHANGED)
        .map(async (e) => {
          const p = e.payload as IssueStatusChangedPayload
          return {
            id: e.id,
            authorHandle: await handleOf(db, e.actorId),
            from: p.from,
            to: p.to,
            at: e.createdAt.toISOString(),
          }
        }),
    )

    return assembleThread({
      issue,
      authorHandle: await handleOf(db, issue.authorId),
      comments,
      statusChanges,
    })
  })

/** Open a new issue as the current actor. Returns the new id. */
export const openIssue = createServerFn({ method: 'POST' })
  .validator(validateOpenIssueInput)
  .handler(async ({ data }) => {
    const actor = await currentActor()
    // Same friendly existence check as the CLI's --playbook: a bad reference
    // fails loudly with what DOES exist, not as a silent FK error.
    if (data.playbookId) await requirePlaybook(db, { id: data.playbookId })
    const issue = await createIssue(db, {
      title: data.title,
      body: data.body,
      playbookId: data.playbookId,
      authorId: actor.id,
    })
    return { id: issue.id, nano: issue.nano }
  })

/** A playbook as the views render it: roster and entrypoint as handles too. */
export interface PlaybookView {
  id: string
  name: string
  description: string
  memberIds: string[]
  memberHandles: string[]
  entrypointId: string
  entrypointHandle: string
  /** True for the ship default (what a null issues.playbookId means). */
  isDefault: boolean
}

/** Every playbook, with member/entrypoint handles resolved for display. */
export const listPlaybooksView = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PlaybookView[]> => {
    bootOrchestrator()
    // The boot above is fire-and-forget (it also reconciles builds — too slow
    // to hold a page load), so on a fresh ship it can race this read and the
    // first render would show no playbooks. Ensuring directly is cheap
    // (create-if-absent; two selects when already seeded) and closes the gap.
    await seedPlaybooks(db)
    return Promise.all(
      (await listPlaybooks(db)).map(async (p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        memberIds: p.memberIds,
        memberHandles: await Promise.all(
          p.memberIds.map((id) => handleOf(db, id)),
        ),
        entrypointId: p.entrypointId,
        entrypointHandle: await handleOf(db, p.entrypointId),
        isDefault: p.name === BUILD_PLAYBOOK_NAME,
      })),
    )
  },
)

/**
 * Create or update a playbook (matched by name — ids stay stable so issues
 * keep pointing at an edited playbook). The shape check is the service's
 * validatePlaybookInput; the semantic validation (roster of real agents,
 * entrypoint on the roster) lives in upsertPlaybook. Both surface here.
 */
export const savePlaybook = createServerFn({ method: 'POST' })
  .validator(validatePlaybookInput)
  .handler(async ({ data }) => {
    // Resolve the actor like every other mutating door — writing a playbook
    // decides which full-tools agent starts future issues, so it must at
    // least be an action BY someone the ship knows.
    await currentActor()
    const saved = await upsertPlaybook(db, data)
    return { id: saved.id }
  })

/** Comment on an issue as the current actor. */
export const commentOnIssue = createServerFn({ method: 'POST' })
  .validator(validateCommentInput)
  .handler(async ({ data }) => {
    const actor = await currentActor()
    await addComment(db, {
      issueId: data.issueId,
      authorId: actor.id,
      body: data.body,
    })
    return { ok: true }
  })

/**
 * Move an issue's status as the current actor. Ensures the orchestrator is
 * subscribed first (so the reaction is guaranteed to be heard in this process),
 * then emits on the ship's log; the orchestrator drives the worktree/builder
 * lifecycle off the bus.
 */
export const setIssueStatus = createServerFn({ method: 'POST' })
  .validator(validateTransitionInput)
  .handler(async ({ data }) => {
    bootOrchestrator()
    const actor = await currentActor()
    const moved = await transitionIssue(db, {
      issueId: data.issueId,
      to: data.to,
      actorId: actor.id,
    })
    return { status: moved.status }
  })
