import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// The users service owns this table: the crew aboard the ship. A user is either
// a human (you, your friends) or an agent (the ship's residents — tilde, bix,
// dot). Every actor that does anything on the ship — sends a message, emits an
// event — resolves to a row here, so `actorId` columns elsewhere point at it.
//
// This is the data half of the crew primitive. The enforcement half is
// Postgres Row-Level Security in the db foundation: the app connects as the
// non-superuser app_user and doors run under withActor, so policies filter
// every query to what the acting user may see (see hull/db/zine.md).

/** Someone aboard the ship — a human or an agent. */
export const users = pgTable('users', {
  /** UUIDv7 — time-ordered, so insertion order is creation order. */
  id: text('id').primaryKey(),
  /** Unique short name, e.g. "drufball". How a human is named on the wire. */
  handle: text('handle').notNull().unique(),
  /** Human-friendly name shown in the UI. */
  displayName: text('display_name').notNull(),
  /** Whether this crew member is a person or one of the ship's agents. */
  type: text('type', { enum: ['human', 'agent'] }).notNull(),
  /**
   * Nullable link to an agent's profile (agent_profiles.id). A plain column
   * with no FK, deliberately: the agent schema already FKs users for its
   * agentUserId, and a reverse FK here would make the schemas import each
   * other (see hull/users/zine.md).
   */
  profileId: text('profile_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type UserRow = typeof users.$inferSelect
