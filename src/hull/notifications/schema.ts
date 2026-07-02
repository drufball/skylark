import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

import { users } from '@hull/users/schema'

// The notifications service owns these tables: every user's inbox, and the
// watch list that feeds it. A watch says "tell <user> when something happens on
// <topic>"; the service's reactor turns watched ship-log events into inbox
// rows. Humans read theirs on the Inbox surface; an agent's notifications wake
// it (see the chat orchestrator). RLS scopes both tables to their owner — the
// policies live in the migration, not here (see migrations/0010).

/** One inbox entry: something happened on a topic this user watches. */
export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    /** Whose inbox this is. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The ship-log event type that caused it (e.g. "issue.commented"). */
    type: text('type').notNull(),
    /** The watched topic the event rode (e.g. "issue:abc1"). */
    topic: text('topic').notNull(),
    /** The event's payload, carried so the inbox can render context. */
    payload: jsonb('payload').notNull(),
    /** Who caused it — a users.id; null for system-originated events. */
    actorId: text('actor_id'),
    /** Set when the user has seen it; null = unread. */
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('notifications_user_idx').on(table.userId, table.id)],
)

export type NotificationRow = typeof notifications.$inferSelect

/** One subscription: notify this user about events on this topic. */
export const watches = pgTable(
  'watches',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.topic] }),
    index('watches_topic_idx').on(table.topic),
  ],
)

export type WatchRow = typeof watches.$inferSelect
