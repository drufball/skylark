import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

import { agentSessions } from '@hull/agent/schema'
import { users } from '@hull/users/schema'

// The chat service owns these tables. A chat is a conversation between a set of
// users (humans and agents); membership IS visibility — only members see a chat,
// and an added member sees the whole history (no per-message ACL). Chat lives in
// the hull: it's load-bearing (there's more planned for it) and it drives the
// ship's resident agents, like the issues board does.
//
// Agents are members too. When a chat needs an agent to speak, the chat
// orchestrator drives a backing agent session (one per chat+agent, recorded on
// the membership row) and posts the agent's reply back as a chat message — so
// the clean chat transcript here and the agent's full tool-call transcript stay
// separate surfaces over one conversation.

/** One conversation. */
export const chats = pgTable('chats', {
  id: text('id').primaryKey(),
  /** Optional human title; null shows as the member list. */
  title: text('title'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Bumped on every message — drives the recency-ordered sidebar. */
  lastMessageAt: timestamp('last_message_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/**
 * Who is in a chat — the visibility list. One row per (chat, user). For an agent
 * member, `sessionId` points at the backing agent session that speaks for it in
 * this chat (created lazily on first response, kept so the agent has continuity).
 */
export const chatMembers = pgTable(
  'chat_members',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The agent's backing session for this chat; null for humans / not-yet-spoken. */
    sessionId: text('session_id').references(() => agentSessions.id, {
      onDelete: 'set null',
    }),
    /**
     * The agent's latest live "working…" line, persisted (not just streamed
     * over SSE) so the bubble survives a page navigation. Null when the agent
     * isn't mid-turn.
     */
    progressLine: text('progress_line'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.userId] })],
)

/** One message in a chat, authored by a member (human or agent). */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('chat_messages_chat_idx').on(table.chatId, table.id)],
)

/**
 * A message queued to post itself into a chat later — one-shot or recurring —
 * owned entirely by the chat service. It fires by posting a chat message AS its
 * `authorId` (the same message write + event as any post, committed atomically
 * with the schedule's advance), so the existing reply rules do the rest: a
 * human-authored schedule triggers agent replies (a recurring task), an
 * agent-authored one triggers none (a recurring announcement; agents never
 * trigger agents).
 *
 * Timing is one of two shapes, never both: a one-shot carries `fireAt` (and is
 * disabled once it fires); a recurring one carries `intervalMinutes` with a
 * `nextFireAt` advanced each fire. Schedules ride chat membership like messages
 * (RLS, migration 0027) — visible to every member, no invisible clockwork.
 *
 * NOTE: the timing XOR and the author rule ("posts as the creator or an agent
 * member, never another human") are enforced at the doors (scheduleTiming,
 * canAuthorSchedule in service.ts), NOT in the schema/RLS — every write path
 * must go through them. RLS only gates visibility by chat membership.
 */
export const chatSchedules = pgTable(
  'chat_schedules',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    /** The member this posts AS — the creator themself, or an agent member; never another human. */
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    /** One-shot: the single time to fire. Null for a recurring schedule. */
    fireAt: timestamp('fire_at', { withTimezone: true }),
    /** Recurring: whole minutes between fires (floor enforced at the door). Null for a one-shot. */
    intervalMinutes: integer('interval_minutes'),
    /** Recurring: the next time to fire, advanced each fire. Null for a one-shot. */
    nextFireAt: timestamp('next_fire_at', { withTimezone: true }),
    /** Off never fires; a fired one-shot is disabled (consumed), not deleted. */
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Who created the schedule (audit) — distinct from `authorId`, who it posts as. */
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    index('chat_schedules_chat_idx').on(table.chatId),
    // The sweep scans enabled rows by due time (fireAt for one-shots, nextFireAt for recurring).
    index('chat_schedules_due_idx').on(
      table.enabled,
      table.fireAt,
      table.nextFireAt,
    ),
  ],
)

export type ChatRow = typeof chats.$inferSelect
export type ChatMemberRow = typeof chatMembers.$inferSelect
export type ChatMessageRow = typeof chatMessages.$inferSelect
export type ChatScheduleRow = typeof chatSchedules.$inferSelect
