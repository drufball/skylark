import { sql } from 'drizzle-orm'
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

// The agent service owns these tables. Postgres is the source of truth for every
// conversation: a session is a thin row of metadata, and every message (user,
// assistant, tool call, tool result, thinking) is one durable row. The live
// pi.dev session that actually talks to Claude is ephemeral and rebuilt from
// these rows — so a crash loses at most the in-flight turn, never history.
//
// No crew column yet: the crew primitive (see hull/zine.md) isn't built, so the
// ship is single-tenant for now. Crew-scoping attaches here when it lands.

/** A conversation with the agent. */
export const agentSessions = pgTable('agent_sessions', {
  id: text('id').primaryKey(),
  /** First user message, trimmed — what the sidebar shows. */
  title: text('title'),
  /** pi.dev model id, e.g. "claude-sonnet-4-5". */
  model: text('model').notNull(),
  /**
   * "running" while a turn is in flight in some process, otherwise "idle".
   * "error" records a turn that failed. A row stuck on "running" after a crash
   * is stale; cancel forces it back to idle.
   */
  status: text('status', { enum: ['idle', 'running', 'error'] })
    .notNull()
    .default('idle'),
  /** Last failure message, when status is "error". */
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Bumped on every message — drives the sidebar order and the date filter. */
  lastMessageAt: timestamp('last_message_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/**
 * One message in a session, stored verbatim as a pi.dev AgentMessage. The
 * identity column gives a stable, monotonic order (we persist sequentially at
 * turn boundaries), so reading them back in `seq` order rebuilds the transcript.
 */
export const agentMessages = pgTable(
  'agent_messages',
  {
    seq: bigint('seq', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    /** AgentMessage.role: user | assistant | toolResult | custom | … */
    role: text('role').notNull(),
    /** The full pi.dev AgentMessage object, verbatim. */
    message: jsonb('message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [index('agent_messages_session_idx').on(table.sessionId)],
)

export type AgentSessionRow = typeof agentSessions.$inferSelect
export type AgentMessageRow = typeof agentMessages.$inferSelect
