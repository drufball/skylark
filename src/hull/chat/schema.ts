import {
  index,
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

export type ChatRow = typeof chats.$inferSelect
export type ChatMemberRow = typeof chatMembers.$inferSelect
export type ChatMessageRow = typeof chatMessages.$inferSelect
