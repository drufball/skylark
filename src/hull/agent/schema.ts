import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
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
// No crew column yet: the crew primitive (see hull/zine.md) isn't built, so the
// ship is single-tenant for now. Crew-scoping attaches here when it lands.

/**
 * A reusable agent configuration. A profile is the full recipe the runtime
 * resolves into pi.dev session options: which tools, what system prompt,
 * whether to read CLAUDE.md, whether to load the repo's skills, which
 * extensions to load, and an optional model override. One runtime drives many
 * kinds of agent (a read-only chat pilot, a full builder) from these rows
 * instead of hardcoded options.
 */
export const agentProfiles = pgTable('agent_profiles', {
  /** UUIDv7 — time-ordered, so insertion order is creation order. */
  id: text('id').primaryKey(),
  /** Unique name, e.g. "chat" or "builder". How sessions/users reference it. */
  name: text('name').notNull().unique(),
  /** System prompt for the agent. Null = pi.dev's default system prompt. */
  systemPrompt: text('system_prompt'),
  /**
   * Allowlist of tool names, e.g. ['read','bash']. Null means "the default
   * coding tools" (read/bash/edit/write) — the builder's full toolset.
   */
  tools: jsonb('tools').$type<string[] | null>(),
  /** Whether to feed the ship's CLAUDE.md to the agent. */
  readContextFiles: boolean('read_context_files').notNull(),
  /** Whether to load the repo's skill directories. */
  useRepoSkills: boolean('use_repo_skills').notNull(),
  /** Extension ids (→ extensions.id) to load for this profile. */
  extensionIds: jsonb('extension_ids').$type<string[]>().notNull().default([]),
  /** Optional model id override, e.g. "claude-opus-4-5". Null = session/default. */
  model: text('model'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/**
 * The extensions registry: a row per pi.dev TS extension available on the ship.
 * Profiles reference these by id. Extensions are code (under the repo) that
 * intercept the agent runtime — the build-gates extension is the first. The
 * registry is how profiles and the future UX name them without hardcoding paths.
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
   * The profile this session boots with (→ agent_profiles.id). Null for
   * sessions created before profiles existed; the runtime falls back to the
   * built-in coding defaults then.
   */
  profileId: text('profile_id').references(() => agentProfiles.id),
  /**
   * Working directory the session's tools operate in. Null = the repo root
   * (process.cwd()). M3's building agents set this to a per-worktree path so
   * concurrent in-process sessions don't collide.
   */
  cwd: text('cwd'),
  /**
   * The crew member this session acts as (→ users.id). Null = unattributed
   * (the single-tenant default). Lets a session carry an agent's identity.
   */
  agentUserId: text('agent_user_id').references(() => users.id),
  /**
   * Where this session came from, as a ship-log topic — `chat:<id>`,
   * `issue:<id>`, or null for a bare/CLI session. A session has no crew column
   * of its own; it INHERITS visibility from its origin (an issue's session is
   * public; a chat's follows that chat's membership). The RLS policy dispatches
   * on this label, so the access rule lives in the database, not in every
   * reader — see migration 0008.
   */
  origin: text('origin'),
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
export type AgentProfileRow = typeof agentProfiles.$inferSelect
export type ExtensionRow = typeof extensions.$inferSelect
