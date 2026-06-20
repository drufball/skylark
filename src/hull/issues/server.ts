import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { listEventsSince } from '@hull/events/service'
import { currentActor } from '@hull/users/actor'
import { getUserById } from '@hull/users/service'

import { ensureOrchestrator } from './orchestrator-live'
import {
  addComment,
  createIssue,
  getIssue,
  ISSUE_STATUS_CHANGED,
  issueScope,
  listComments,
  listIssues,
  resolveStatusWord,
  transitionIssue,
} from './service'
import type { IssueStatus } from './schema'

// The web doors onto the issues service — the message board. Issues are created
// by currentActor() (the operator) and comments by the current actor, so the UI
// never has to ask "who are you". A transition fires the orchestrator inline AND
// rides the ship's log; the orchestrator is also subscribed to the log so an
// agent's CLI transition in another process is heard too.

/** Boot the orchestrator into this server process on first issues use. */
function bootOrchestrator(): void {
  void ensureOrchestrator().catch((err: unknown) => {
    console.error(`orchestrator boot failed: ${String(err)}`)
  })
}

/** A board card: an issue plus its author handle and comment count. */
export interface BoardIssue {
  id: string
  nano: string
  title: string
  status: IssueStatus
  authorHandle: string
  commentCount: number
  statusLine: string | null
  updatedAt: string
}

/** All issues as board cards, newest first. The board groups by status itself. */
export const listBoard = createServerFn({ method: 'GET' }).handler(async () => {
  bootOrchestrator()
  const issues = await listIssues(db)
  const cards: BoardIssue[] = []
  for (const issue of issues) {
    const author = await getUserById(db, issue.authorId)
    const comments = await listComments(db, issue.id)
    cards.push({
      id: issue.id,
      nano: issue.nano,
      title: issue.title,
      status: issue.status,
      authorHandle: author?.handle ?? '?',
      commentCount: comments.length,
      statusLine: issue.statusLine,
      updatedAt: issue.updatedAt.toISOString(),
    })
  }
  return cards
})

/** One thread item: a comment or a status-change entry, in time order. */
export type ThreadEntry =
  | {
      kind: 'comment'
      id: string
      authorHandle: string
      body: string
      at: string
    }
  | {
      kind: 'status'
      id: string
      authorHandle: string
      from: IssueStatus
      to: IssueStatus
      at: string
    }

export interface IssueThread {
  id: string
  nano: string
  title: string
  body: string
  status: IssueStatus
  authorHandle: string
  branchName: string | null
  statusLine: string | null
  entries: ThreadEntry[]
}

/**
 * An issue with its full thread: comments and status-change entries merged and
 * sorted by time (both carry UUIDv7 ids, so id order is time order). The status
 * entries come from the ship's log on the issue's scope — the durable record of
 * who moved it and when.
 */
export const getThread = createServerFn({ method: 'GET' })
  .validator((issueId: string) => issueId)
  .handler(async ({ data: issueId }): Promise<IssueThread | null> => {
    bootOrchestrator()
    const issue = await getIssue(db, issueId)
    if (!issue) return null
    const author = await getUserById(db, issue.authorId)
    const comments = await listComments(db, issueId)
    const events = await listEventsSince(db, { scopes: [issueScope(issueId)] })

    const entries: ThreadEntry[] = []
    for (const c of comments) {
      const who = await getUserById(db, c.authorId)
      entries.push({
        kind: 'comment',
        id: c.id,
        authorHandle: who?.handle ?? '?',
        body: c.body,
        at: c.createdAt.toISOString(),
      })
    }
    for (const e of events) {
      if (e.type !== ISSUE_STATUS_CHANGED) continue
      const who = e.actorId ? await getUserById(db, e.actorId) : undefined
      const p = e.payload as { from: IssueStatus; to: IssueStatus }
      entries.push({
        kind: 'status',
        id: e.id,
        authorHandle: who?.handle ?? '?',
        from: p.from,
        to: p.to,
        at: e.createdAt.toISOString(),
      })
    }
    // Both ids are UUIDv7, so a lexical id sort is a chronological sort.
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    return {
      id: issue.id,
      nano: issue.nano,
      title: issue.title,
      body: issue.body,
      status: issue.status,
      authorHandle: author?.handle ?? '?',
      branchName: issue.branchName,
      statusLine: issue.statusLine,
      entries,
    }
  })

/** Open a new issue as the current actor. Returns the new id. */
export const openIssue = createServerFn({ method: 'POST' })
  .validator((input: { title: string; body?: string }) => input)
  .handler(async ({ data }) => {
    const actor = await currentActor()
    const issue = await createIssue(db, {
      title: data.title,
      body: data.body,
      authorId: actor.id,
    })
    return { id: issue.id, nano: issue.nano }
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
 * Move an issue's status as the current actor. Boots the orchestrator first so
 * the reaction it subscribes for is guaranteed to be heard in this process; the
 * transition then emits on the ship's log and the orchestrator drives the
 * worktree/builder lifecycle.
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
