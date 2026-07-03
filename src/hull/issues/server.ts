import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { listEventsSince, PUBLIC_AUDIENCE } from '@hull/events/service'
import { currentActor } from '@hull/users/actor'
import { handleOf } from '@hull/users/service'

import { ensureOrchestrator } from './orchestrator-live'
import { listPlaybooks, upsertPlaybook } from './playbooks'
import {
  addComment,
  assembleThread,
  createIssue,
  getIssue,
  ISSUE_STATUS_CHANGED,
  issueTopic,
  listComments,
  listIssues,
  resolveStatusWord,
  toBoardCard,
  transitionIssue,
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
  .validator(
    (input: { title: string; body?: string; playbookId?: string }) => input,
  )
  .handler(async ({ data }) => {
    const actor = await currentActor()
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
}

/** Every playbook, with member/entrypoint handles resolved for display. */
export const listPlaybooksView = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PlaybookView[]> => {
    bootOrchestrator() // boot seeds the standard playbooks
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
      })),
    )
  },
)

/**
 * Create or update a playbook (matched by name — ids stay stable so issues
 * keep pointing at an edited playbook). Validation (roster of real agents,
 * entrypoint on the roster) lives in the service and its errors surface here.
 */
export const savePlaybook = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      name: string
      description?: string
      memberIds: string[]
      entrypointId: string
    }) => input,
  )
  .handler(async ({ data }) => {
    const saved = await upsertPlaybook(db, {
      name: data.name.trim(),
      description: data.description,
      memberIds: data.memberIds,
      entrypointId: data.entrypointId,
    })
    return { id: saved.id }
  })

/** Comment on an issue as the current actor. */
export const commentOnIssue = createServerFn({ method: 'POST' })
  .validator((input: { issueId: string; body: string }) => input)
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
  .validator((input: { issueId: string; status: string }) => input)
  .handler(async ({ data }) => {
    bootOrchestrator()
    const to = resolveStatusWord(data.status)
    if (!to) throw new Error(`Unknown status: ${data.status}`)
    const actor = await currentActor()
    const moved = await transitionIssue(db, {
      issueId: data.issueId,
      to,
      actorId: actor.id,
    })
    return { status: moved.status }
  })
