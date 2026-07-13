import { sql } from 'drizzle-orm'
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

import { users } from '@hull/users/schema'

// The agent service owns these tables. Postgres is the source of truth for every
// conversation: a session is a thin row of metadata, and every message (user,
// assistant, tool call, tool result, thinking) is one durable row. The live
// pi.dev session that actually talks to Claude is ephemeral and rebuilt from
// these rows — so a crash loses at most the in-flight turn, never history.
//
// Crew-scoping: a session carries the crew member it acts as (agentUserId), and
// its visibility is enforced with Row-Level Security by where it came from —
// an issue's session is public, a chat's follows membership, a bare session is
// crew-visible (migration 0008; see hull/db/zine.md).

/**
 * The extensions registry: a row per pi.dev TS extension available on the ship.
 * Agent users reference these by id (users.extensionIds). Extensions are code
 * (under the repo) that intercept the agent runtime — the build-gates extension
 * is the first. The registry is how an agent's config (and the UX) names an
 * extension without hardcoding paths.
 */
export const extensions = pgTable('extensions', {
  /** UUIDv7 — time-ordered. */
  id: text('id').primaryKey(),
  /** Unique name, e.g. "build-gates". */
  name: text('name').notNull().unique(),
  /** What this extension does, for humans browsing the registry. */
  description: text('description').notNull(),
  /** Repo-relative path to the extension's TS module. */
  path: text('path').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/** A conversation with the agent. */
export const agentSessions = pgTable('agent_sessions', {
  id: text('id').primaryKey(),
  /** First user message, trimmed — what the sidebar shows. */
  title: text('title'),
  /** pi.dev model id, e.g. "claude-sonnet-4-5". */
  model: text('model').notNull(),
  /**
   * Working directory the session's tools operate in. Null = the repo root
   * (process.cwd()). M3's building agents set this to a per-worktree path so
   * concurrent in-process sessions don't collide.
   */
  cwd: text('cwd'),
  /**
   * The crew member this session acts as (→ users.id). Null = unattributed
   * (the single-tenant default). Carries the agent's identity AND its boot
   * config: the runtime reads the user row's agent-config columns; a session
   * with no agentUserId boots the built-in coding defaults.
   */
  agentUserId: text('agent_user_id').references(() => users.id),
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

/**
 * A background job an agent handed off (the `background` tool) — the durable
 * record `background.ts`'s in-process `Set<Job>` never had, which is the whole
 * reason a reload used to strand a session forever (issue #v6ft). A row exists
 * from `start()` until the job is accounted for — either its real `onClose`
 * fires in the process that spawned it, or the boot-time reconciler
 * (`reconcile.ts`) claims it because that process is gone. There is no status
 * column: every row in this table IS an outstanding job by definition, so
 * "list outstanding jobs" is just "every row".
 *
 * `pid` is carried for completeness/observability (which OS process this was)
 * but is NOT used to re-attach across a reload: a fresh process has no handle
 * on the old child's stdout/stderr pipes even if the OS process happens to
 * still be alive, so there is no way to recover its output honestly. The
 * reconciler therefore always treats a row it finds at boot as "the job's
 * fate is unknown" and resumes the session with an explicit message to redo
 * the command — see reconcile.ts for the rationale (a documented, deliberate
 * v1 scope: no re-attach).
 */
export const backgroundJobs = pgTable('background_jobs', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => agentSessions.id, { onDelete: 'cascade' }),
  /** The shell command that was backgrounded. */
  command: text('command').notNull(),
  /** Short label the agent gave it ("PR #12 CI") — echoed in the resume. */
  label: text('label').notNull(),
  /** Working directory the command ran in. */
  cwd: text('cwd').notNull(),
  /** The OS pid of the spawned child, for observability — see doc comment. */
  pid: bigint('pid', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type AgentSessionRow = typeof agentSessions.$inferSelect
export type AgentMessageRow = typeof agentMessages.$inferSelect
export type ExtensionRow = typeof extensions.$inferSelect
export type BackgroundJobRow = typeof backgroundJobs.$inferSelect
