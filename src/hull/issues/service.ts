import { randomInt } from 'node:crypto'

import { uuidv7 } from '@earendil-works/pi-agent-core'
import { asc, desc, eq } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import { emitEvent } from '@hull/events/bus'
import { PUBLIC_SCOPE } from '@hull/events/service'

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
 * Every state change and every comment is announced on the ship's log, on TWO
 * scopes: `issue:<id>` (the thread view subscribes here) and `public` (the board
 * subscribes here, and the server-side orchestrator listens here to drive the
 * build lifecycle across processes — an agent's CLI transition in another
 * process is still heard).
 */

/** The scope a single issue's events are published under. */
export function issueScope(issueId: string): string {
  return `issue:${issueId}`
}

/** Event types this service emits (one name, used by emitters and subscribers). */
export const ISSUE_STATUS_CHANGED = 'issue.status_changed'
export const ISSUE_COMMENTED = 'issue.commented'

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
 * Add a comment and announce it on the ship's log (issue + public scopes). The
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
  await emitEvent(db, {
    type: ISSUE_COMMENTED,
    source: 'issues',
    scope: issueScope(input.issueId),
    actorId: input.authorId,
    payload: { issueId: input.issueId, commentId: row.id },
  })
  await emitEvent(db, {
    type: ISSUE_COMMENTED,
    source: 'issues',
    scope: PUBLIC_SCOPE,
    actorId: input.authorId,
    payload: { issueId: input.issueId, commentId: row.id },
  })
  return row
}

/**
 * Move an issue's status through the legal machine, bump updatedAt, and announce
 * the change on the ship's log (issue + public scopes). An illegal move throws
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

  const payload = { issueId: input.issueId, from: current.status, to }
  await emitEvent(db, {
    type: ISSUE_STATUS_CHANGED,
    source: 'issues',
    scope: issueScope(input.issueId),
    actorId: input.actorId,
    payload,
  })
  await emitEvent(db, {
    type: ISSUE_STATUS_CHANGED,
    source: 'issues',
    scope: PUBLIC_SCOPE,
    actorId: input.actorId,
    payload,
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
