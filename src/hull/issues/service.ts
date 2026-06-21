import { randomInt } from 'node:crypto'

import { uuidv7 } from '@earendil-works/pi-agent-core'
import { asc, desc, eq } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import { emitEvent } from '@hull/events/bus'
import { PUBLIC_AUDIENCE } from '@hull/events/service'

import { issueScope } from './scope'
import {
  issueComments,
  issues,
  type IssueCommentRow,
  type IssueRow,
  type IssueStatus,
} from './schema'

/**
 * Pure persistence + the legal state machine for the issues service — the ship's
 * message board. Database-agnostic like every service: hand it any drizzle
 * database (live Postgres or PGlite in tests). It writes only its own two tables
 * and learns nothing about other services by reading them — it records ids
 * (authorId, sessionId) and speaks to the world through the ship's log.
 *
 * Every state change and every comment is announced on the ship's log ONCE,
 * with topic `issue:<id>` and audience `public`. The thread view subscribes to
 * the exact topic (`issue:<id>`); the board subscribes to the wildcard
 * (`issue:*`); the server-side orchestrator listens too, to drive the build
 * lifecycle across processes — an agent's CLI transition in another process is
 * still heard. One topic, many subscribers; no dual-emit.
 */

// issueScope lives in ./scope (a node-free leaf — see that file for why).
// Re-exported here so server callers still reach it through the service.
export { issueScope }

/** Event types this service emits (one name, used by emitters and subscribers). */
export const ISSUE_STATUS_CHANGED = 'issue.status_changed'
export const ISSUE_COMMENTED = 'issue.commented'

/**
 * Announce an issue event ONCE with topic (issue:<id>) and audience (public).
 * The topic lets the thread view subscribe ("issue:123"); the audience lets the
 * board view subscribe ("issue:*" with audience=public). Subscribers express
 * interest via topic patterns; access is enforced via audience. This retires the
 * dual-emit pattern — one durable row per logical event, not two.
 */
async function announce(
  db: Database,
  input: { type: string; issueId: string; actorId: string; payload: unknown },
): Promise<void> {
  await emitEvent(db, {
    type: input.type,
    source: 'issues',
    topic: issueScope(input.issueId),
    audience: PUBLIC_AUDIENCE,
    actorId: input.actorId,
    payload: input.payload,
  })
}

/** The alphabet for a nano id: lowercase alnum, so it's url- and git-ref-safe. */
const NANO_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const NANO_LENGTH = 4

/**
 * A fresh 4-char url/git-safe short id. 36^4 ≈ 1.7M of space — plenty for a
 * crew's board, and uniqueness is still enforced at insert time (`createIssue`
 * retries on the unique constraint). `randomInt` is unbiased over the alphabet.
 */
export function generateNano(): string {
  let out = ''
  for (let i = 0; i < NANO_LENGTH; i++) {
    out += NANO_ALPHABET[randomInt(NANO_ALPHABET.length)]
  }
  return out
}

/** How many times to redraw a colliding nano before giving up. */
const NANO_MAX_ATTEMPTS = 10

/**
 * The legal transitions, by source status. open↔building, building→done,
 * open|building→closed; done and closed are terminal. A status never
 * transitions to itself.
 */
const ALLOWED: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ['building', 'closed'],
  building: ['open', 'done', 'closed'],
  done: [],
  closed: [],
}

/** Thrown when a transition isn't in the legal state machine. Names both ends. */
export class IssueTransitionError extends Error {
  constructor(
    readonly from: IssueStatus,
    readonly to: IssueStatus,
  ) {
    super(`Illegal issue transition: ${from} → ${to}`)
    this.name = 'IssueTransitionError'
  }
}

/**
 * The pure heart of the machine: given the current status and a requested one,
 * return the requested status if the move is legal, else throw. Pure and
 * exhaustively unit-tested — every door in the system (CLI, web, orchestrator)
 * routes its transitions through here so the rules live in exactly one place.
 */
export function nextStatus(from: IssueStatus, to: IssueStatus): IssueStatus {
  if (!ALLOWED[from].includes(to)) throw new IssueTransitionError(from, to)
  return to
}

/**
 * The status words the CLI accepts, mapped to a target status. `close` is the
 * friendly verb for `closed` (you don't "close to closed"). Used by the issue
 * CLI's `status <id> <word>` form and its explicit `building`/`open`/`done`/
 * `close` subcommands, so both routes agree on the vocabulary. Returns
 * undefined for an unknown word — the CLI turns that into a usage error.
 */
export function resolveStatusWord(word: string): IssueStatus | undefined {
  switch (word) {
    case 'open':
      return 'open'
    case 'building':
      return 'building'
    case 'done':
      return 'done'
    case 'close':
    case 'closed':
      return 'closed'
    default:
      return undefined
  }
}

export async function createIssue(
  db: Database,
  input: {
    title: string
    body?: string
    authorId: string
    /** Force a nano (tests/seeding); otherwise generated + retried for uniqueness. */
    nano?: string
    /** Injectable generator so the collision-retry path is testable. */
    generateNano?: () => string
  },
): Promise<IssueRow> {
  const gen = input.generateNano ?? generateNano
  let lastErr: unknown
  for (let attempt = 0; attempt < NANO_MAX_ATTEMPTS; attempt++) {
    const nano = input.nano ?? gen()
    try {
      const [row] = await db
        .insert(issues)
        .values({
          id: uuidv7(),
          nano,
          title: input.title,
          body: input.body ?? '',
          authorId: input.authorId,
        })
        .returning()
      return row
    } catch (err) {
      // A forced nano can't be retried into a new value — surface immediately.
      if (input.nano) throw err
      lastErr = err
    }
  }
  throw new Error(
    `Could not generate a unique issue nano after ${String(NANO_MAX_ATTEMPTS)} attempts: ${String(lastErr)}`,
  )
}

export async function getIssue(
  db: Database,
  id: string,
): Promise<IssueRow | undefined> {
  const [row] = await db.select().from(issues).where(eq(issues.id, id))
  return row
}

/** Resolve an issue by its short nano (the id used in CLI + branch names). */
export async function getIssueByNano(
  db: Database,
  nano: string,
): Promise<IssueRow | undefined> {
  const [row] = await db.select().from(issues).where(eq(issues.nano, nano))
  return row
}

/**
 * Resolve an issue from a CLI/branch reference: a 4-char nano (what agents type,
 * and what's embedded in branch names) or a full UUID. Tries nano first since
 * that's the common case, then falls back to the id. Returns undefined if
 * neither matches.
 */
export async function resolveIssueRef(
  db: Database,
  ref: string,
): Promise<IssueRow | undefined> {
  return (await getIssueByNano(db, ref)) ?? (await getIssue(db, ref))
}

/** Every issue, newest first (UUIDv7 ids are time-ordered). */
export async function listIssues(db: Database): Promise<IssueRow[]> {
  return db.select().from(issues).orderBy(desc(issues.id))
}

/** Every comment on an issue, in thread (creation) order. */
export async function listComments(
  db: Database,
  issueId: string,
): Promise<IssueCommentRow[]> {
  return db
    .select()
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId))
    .orderBy(asc(issueComments.id))
}

/**
 * Add a comment and announce it on the ship's log (topic issue:<id>). The
 * comment row is the durable truth; the event is the "thread changed" doorbell
 * the views and the orchestrator hear.
 */
export async function addComment(
  db: Database,
  input: { issueId: string; authorId: string; body: string },
): Promise<IssueCommentRow> {
  const [row] = await db
    .insert(issueComments)
    .values({
      id: uuidv7(),
      issueId: input.issueId,
      authorId: input.authorId,
      body: input.body,
    })
    .returning()
  await announce(db, {
    type: ISSUE_COMMENTED,
    issueId: input.issueId,
    actorId: input.authorId,
    payload: { issueId: input.issueId, commentId: row.id },
  })
  return row
}

/**
 * Move an issue's status through the legal machine, bump updatedAt, and announce
 * the change on the ship's log (topic issue:<id>). An illegal move throws
 * (IssueTransitionError) before any write or emit, so a rejected transition
 * leaves the row and the log untouched.
 */
export async function transitionIssue(
  db: Database,
  input: { issueId: string; to: IssueStatus; actorId: string },
): Promise<IssueRow> {
  const current = await getIssue(db, input.issueId)
  if (!current) throw new Error(`No such issue: ${input.issueId}`)
  const to = nextStatus(current.status, input.to)

  const [row] = await db
    .update(issues)
    .set({ status: to, updatedAt: new Date() })
    .where(eq(issues.id, input.issueId))
    .returning()

  await announce(db, {
    type: ISSUE_STATUS_CHANGED,
    issueId: input.issueId,
    actorId: input.actorId,
    payload: { issueId: input.issueId, from: current.status, to },
  })
  return row
}

/**
 * Record the build context (branch, worktree, builder session) on an issue.
 * Set by the orchestrator on the first → building transition; idempotent — it
 * just overwrites with the latest values, which on a reuse are the same.
 */
export async function setBuildContext(
  db: Database,
  issueId: string,
  ctx: {
    branchName?: string | null
    worktreePath?: string | null
    sessionId?: string | null
  },
): Promise<void> {
  await db
    .update(issues)
    .set({ ...ctx, updatedAt: new Date() })
    .where(eq(issues.id, issueId))
}

/** Write the latest builder progress line shown live on the board/thread. */
export async function setStatusLine(
  db: Database,
  issueId: string,
  statusLine: string,
): Promise<void> {
  await db.update(issues).set({ statusLine }).where(eq(issues.id, issueId))
}

// --- View-data shaping (pure, so it's PGlite-testable, not welded to the doors) ---

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

/** A status-change record as the thread assembler needs it (from the log). */
export interface StatusChange {
  id: string
  authorHandle: string
  from: IssueStatus
  to: IssueStatus
  at: string
}

/** Shape one issue + its author handle + comment count into a board card. */
export function toBoardCard(
  issue: IssueRow,
  authorHandle: string,
  commentCount: number,
): BoardIssue {
  return {
    id: issue.id,
    nano: issue.nano,
    title: issue.title,
    status: issue.status,
    authorHandle,
    commentCount,
    statusLine: issue.statusLine,
    updatedAt: issue.updatedAt.toISOString(),
  }
}

/**
 * Merge an issue's comments and its status changes into one timeline, sorted by
 * id. Both ids are UUIDv7, so a lexical id sort IS a chronological sort — the
 * load-bearing assumption this function exists to make testable. Pure: hand it
 * already-fetched rows (with resolved author handles) and it does the shaping.
 */
export function assembleThread(input: {
  issue: IssueRow
  authorHandle: string
  comments: { id: string; authorHandle: string; body: string; at: string }[]
  statusChanges: StatusChange[]
}): IssueThread {
  const entries: ThreadEntry[] = [
    ...input.comments.map(
      (c): ThreadEntry => ({
        kind: 'comment',
        id: c.id,
        authorHandle: c.authorHandle,
        body: c.body,
        at: c.at,
      }),
    ),
    ...input.statusChanges.map(
      (s): ThreadEntry => ({
        kind: 'status',
        id: s.id,
        authorHandle: s.authorHandle,
        from: s.from,
        to: s.to,
        at: s.at,
      }),
    ),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return {
    id: input.issue.id,
    nano: input.issue.nano,
    title: input.issue.title,
    body: input.issue.body,
    status: input.issue.status,
    authorHandle: input.authorHandle,
    branchName: input.issue.branchName,
    statusLine: input.issue.statusLine,
    entries,
  }
}
