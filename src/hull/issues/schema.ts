import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

import { agentSessions } from '@hull/agent/schema'
import { chats } from '@hull/chat/schema'
import { users } from '@hull/users/schema'

// The issues service owns these three tables: the ship's message board. An
// issue is a unit of work or discussion — a forum thread that can become a
// build. Agents are launched off an issue into ONE shared worktree, each with
// its own session (issue_sessions), passing a baton between them via handoffs;
// they report back by commenting and moving the issue's status. Comments,
// status changes, and handoffs all ride the ship's log (hull/events) so the
// board updates live and the orchestrator (server-side) can react across
// processes.
//
// FKs reach into other services only by id (authorId → users.id, sessionId →
// agent_sessions.id) — the same one-way reference pattern the events and agent
// schemas already use. The issues service never *queries* those tables; it
// learns about the world through events and only records the ids it owns.
//
// No crew column yet: the crew primitive's compile-time filter (see hull/zine.md)
// isn't built, so the ship is single-tenant. `visibility` is here as room to
// grow, defaulting to public; crew-scoping attaches when the primitive lands.

/**
 * A playbook: how an issue gets worked. A roster of agent crew members allowed
 * hands on the issue, and the entrypoint whose session a → building seeds. The
 * routing knowledge (who hands to whom, when) lives in the agents' own
 * profiles/prompts — the playbook is the guardrail (membership) and the
 * starting gun (entrypoint), deliberately not a state machine.
 */
export const playbooks = pgTable('playbooks', {
  /** UUIDv7 — time-ordered, so insertion order is creation order. */
  id: text('id').primaryKey(),
  /** Unique name, e.g. "build" or "general". How humans and CLIs pick one. */
  name: text('name').notNull().unique(),
  /** What this strategy is for, for humans browsing the list. */
  description: text('description').notNull().default(''),
  /** Agent crew members (→ users.id) allowed hands on the issue. */
  memberIds: jsonb('member_ids').$type<string[]>().notNull().default([]),
  /** The member whose session a → building seeds (→ users.id). */
  entrypointId: text('entrypoint_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/** A unit of work or discussion on the board — possibly built by an agent. */
export const issues = pgTable(
  'issues',
  {
    /** UUIDv7 — time-ordered, so insertion order is creation order. */
    id: text('id').primaryKey(),
    /**
     * A 4-char url/git-safe short id, unique across issues. It's what shows up
     * in a build branch name (`<slug>-<nano>`) so a branch is traceable to its
     * issue at a glance without carrying a full UUID.
     */
    nano: text('nano').notNull().unique(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /**
     * The lifecycle state. The legal transitions live in service.ts
     * (`nextStatus`): open↔building, building→done, open|building→closed; done
     * and closed are terminal.
     */
    status: text('status', { enum: ['open', 'building', 'done', 'closed'] })
      .notNull()
      .default('open'),
    /** Who opened it — a users.id. */
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    /**
     * Who answers for it — a users.id, defaulting to the author at creation.
     * Split from authorId so an agent can file work on someone else's behalf:
     * the owner is who `handoff OWNER` pings when the work wants a decision.
     */
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    /**
     * How this issue gets worked (→ playbooks.id). Null means the default:
     * the `build` playbook — so every pre-playbooks issue keeps its meaning
     * and a bare `issue new` still builds.
     */
    playbookId: text('playbook_id').references(() => playbooks.id),
    /** Visibility key — room to grow; public for now (single-tenant ship). */
    visibility: text('visibility', { enum: ['public'] })
      .notNull()
      .default('public'),
    /** The build branch, generated on the first → building transition. */
    branchName: text('branch_name'),
    /** Absolute path to the build worktree, set alongside branchName. */
    worktreePath: text('worktree_path'),
    /**
     * The chat this issue was filed from (→ chats.id), when it was filed from
     * one — how a notification about this issue finds its way back to the
     * conversation that planned it (the agent wake-up). Null for issues filed
     * from the board or a bare CLI.
     */
    originChatId: text('origin_chat_id').references(() => chats.id, {
      onDelete: 'set null',
    }),
    /** Latest one-line builder progress, shown live on the board/thread. */
    statusLine: text('status_line'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('issues_status_idx').on(table.status)],
)

/**
 * Which agents have a hand on an issue: one session per (issue, agent), every
 * one of them in the issue's ONE worktree. The builder's session is a row here
 * like any other; a handoff to another agent adds that agent's row the first
 * time and reuses it after. Sessions are not deleted on teardown — the link is
 * cheap history, and the session rows themselves are the durable transcript.
 */
export const issueSessions = pgTable(
  'issue_sessions',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** Whose hand this is — a users.id of an agent crew member. */
    agentUserId: text('agent_user_id')
      .notNull()
      .references(() => users.id),
    /** The agent's session on this issue (→ agent_sessions.id). */
    sessionId: text('session_id')
      .notNull()
      .unique()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.issueId, table.agentUserId] })],
)

/** One comment on an issue — a forum reply, or a builder's note. */
export const issueComments = pgTable(
  'issue_comments',
  {
    /** UUIDv7 — time-ordered, so reading by id gives thread order. */
    id: text('id').primaryKey(),
    issueId: text('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** Who wrote it — a users.id. */
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('issue_comments_issue_idx').on(table.issueId)],
)

export type IssueRow = typeof issues.$inferSelect
export type IssueCommentRow = typeof issueComments.$inferSelect
export type IssueSessionRow = typeof issueSessions.$inferSelect
export type IssueStatus = IssueRow['status']
export type PlaybookRow = typeof playbooks.$inferSelect
