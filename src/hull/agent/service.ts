import { and, asc, desc, eq, gte, ne } from 'drizzle-orm'

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
    /** Profile the session boots with; null/undefined = the runtime default. */
    profileId?: string | null
    /** Working dir for the session's tools; null/undefined = repo root. */
    cwd?: string | null
    /** The crew member this session acts as; null/undefined = unattributed. */
    agentUserId?: string | null
  },
): Promise<AgentSessionRow> {
  const [row] = await db
    .insert(agentSessions)
    .values({
      id: input.id,
      model: input.model,
      title: input.title,
      profileId: input.profileId,
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
 * List sessions, newest activity first. Filters compose:
 * - `running`: only sessions with a turn in flight (or only those without).
 * - `since`: only sessions whose last message is at or after this time.
 */
export async function listSessions(
  db: Database,
  filters: { running?: boolean; since?: Date } = {},
): Promise<AgentSessionRow[]> {
  const conditions = []
  if (filters.running === true)
    conditions.push(eq(agentSessions.status, 'running'))
  if (filters.running === false)
    conditions.push(ne(agentSessions.status, 'running'))
  if (filters.since)
    conditions.push(gte(agentSessions.lastMessageAt, filters.since))

  return db
    .select()
    .from(agentSessions)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(agentSessions.lastMessageAt))
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
