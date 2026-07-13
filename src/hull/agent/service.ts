import { and, asc, desc, eq, gte, inArray, like } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import { firstLine, truncate } from '@hull/lib/text'

import {
  agentMessages,
  agentSessions,
  type AgentMessageRow,
  type AgentSessionRow,
} from './schema'

/**
 * Pure persistence logic for the agent service — the source of truth for every
 * conversation. Framework-free and database-agnostic: hand it any drizzle
 * database (the live Postgres connection, or in-memory PGlite in tests) and it
 * reads and writes only the agent's own tables. The pi.dev runtime (runtime.ts)
 * is the impure shell that drives Claude and calls these functions to persist.
 */

export type SessionStatus = AgentSessionRow['status']

/** What `title` is derived from: the first user message, trimmed to one line. */
export function titleFromMessage(text: string, max = 80): string {
  return truncate(firstLine(text), max)
}

export async function createSession(
  db: Database,
  input: {
    id: string
    model: string
    title?: string
    /** Working dir for the session's tools; null/undefined = repo root. */
    cwd?: string | null
    /**
     * The crew member this session acts as; null/undefined = unattributed
     * (the runtime default config). The agent's own config rides on this
     * user row — there's no separate profile to point at.
     */
    agentUserId?: string | null
  },
): Promise<AgentSessionRow> {
  const [row] = await db
    .insert(agentSessions)
    .values({
      id: input.id,
      model: input.model,
      title: input.title,
      cwd: input.cwd,
      agentUserId: input.agentUserId,
    })
    .returning()
  return row
}

export async function getSession(
  db: Database,
  id: string,
): Promise<AgentSessionRow | undefined> {
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, id))
  return row
}

/**
 * Resolve a session from a CLI reference: an exact id, or a unique prefix of
 * one — the same convenience `resolveIssueRef` gives the issue CLI, so fleet
 * triage doesn't require copy-pasting a full UUIDv7. Tries the exact id first
 * (the common case once you've already got one from `agent list`), then falls
 * back to a prefix match. Throws if the prefix is ambiguous rather than
 * silently picking one — wrong-session inspection during an incident is worse
 * than a rerun with more characters.
 */
export async function resolveSessionRef(
  db: Database,
  ref: string,
): Promise<AgentSessionRow | undefined> {
  const exact = await getSession(db, ref)
  if (exact) return exact

  const matches = await db
    .select()
    .from(agentSessions)
    .where(like(agentSessions.id, `${ref}%`))
  if (matches.length > 1)
    throw new Error(
      `Ambiguous session ref "${ref}" matches ${String(matches.length)} sessions — use more characters.`,
    )
  return matches[0]
}

/**
 * List sessions, newest activity first. Filters compose:
 * - `running`: only sessions with a turn in flight.
 * - `since`: only sessions whose last message is at or after this time.
 */
export async function listSessions(
  db: Database,
  filters: { running?: true; since?: Date } = {},
): Promise<AgentSessionRow[]> {
  const conditions = []
  if (filters.running) conditions.push(eq(agentSessions.status, 'running'))
  if (filters.since)
    conditions.push(gte(agentSessions.lastMessageAt, filters.since))

  return db
    .select()
    .from(agentSessions)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(agentSessions.lastMessageAt))
}

/**
 * The agent's session with this exact title, if any — how another service
 * finds a well-known session it owns (the chat waker's per-agent inbox
 * session) without keeping its own link table. Titles are only set at session
 * creation, never rewritten, so a well-known title is a stable key. Oldest
 * first (ids are UUIDv7), so a duplicate created by a rare race converges on
 * one winner.
 */
export async function findAgentSessionByTitle(
  db: Database,
  agentUserId: string,
  title: string,
): Promise<AgentSessionRow | undefined> {
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.agentUserId, agentUserId),
        eq(agentSessions.title, title),
      ),
    )
    .orderBy(asc(agentSessions.id))
    .limit(1)
  return row
}

/**
 * Which of these sessions have a turn in flight right now? The question other
 * services ask (issues' handoff gate: "is the baton taken?") without reading
 * this service's table — sessions stay the agent service's own business.
 */
export async function runningSessionIds(
  db: Database,
  sessionIds: string[],
): Promise<string[]> {
  if (sessionIds.length === 0) return []
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        inArray(agentSessions.id, sessionIds),
        eq(agentSessions.status, 'running'),
      ),
    )
  return rows.map((r) => r.id)
}

export async function setStatus(
  db: Database,
  id: string,
  status: SessionStatus,
  error?: string,
): Promise<void> {
  await db
    .update(agentSessions)
    .set({ status, error: error ?? null })
    .where(eq(agentSessions.id, id))
}

/**
 * Append one message and bump the session's activity clock in a single
 * transaction, so the clock never desyncs from the durable message. `message`
 * is stored verbatim — it's a pi.dev AgentMessage, an opaque JSON blob to this
 * layer.
 */
export async function appendMessage(
  db: Database,
  input: { sessionId: string; role: string; message: unknown },
): Promise<AgentMessageRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agentMessages)
      .values({
        sessionId: input.sessionId,
        role: input.role,
        message: input.message,
      })
      .returning()
    await tx
      .update(agentSessions)
      .set({ lastMessageAt: new Date() })
      .where(eq(agentSessions.id, input.sessionId))
    return row
  })
}

/** Every stored message for a session, in turn order. */
export async function getMessages(
  db: Database,
  sessionId: string,
): Promise<AgentMessageRow[]> {
  return db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, sessionId))
    .orderBy(asc(agentMessages.seq))
}
