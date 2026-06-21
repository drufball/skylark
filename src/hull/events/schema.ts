import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

import { users } from '@hull/users/schema'

// The events service owns this table: the ship's log. A durable, append-only
// record of everything that happens on the ship — every service emits here, and
// anything (the web stream, the CLI, another process) reads from here. This is
// NOT ephemeral pub/sub: Postgres is the source of truth, so a subscriber that
// reconnects replays what it missed by id, and the CLI's emits are seen by the
// web server because they're rows, not in-memory signals.
//
// The id is a UUIDv7 — time-ordered — so it doubles as the SSE cursor: "give me
// everything after this id" is a single indexed range scan.

/** One thing that happened on the ship. */
export const events = pgTable(
  'events',
  {
    /** UUIDv7 — time-ordered, so it's also the stream cursor (Last-Event-ID). */
    id: text('id').primaryKey(),
    /** What happened, e.g. "agent.message", "agent.status". A dotted name. */
    type: text('type').notNull(),
    /** Which service emitted it, e.g. "agent". */
    source: text('source').notNull(),
    /**
     * The entity stream this event belongs to (e.g. "issue:123", "chat:456").
     * Subscribers express interest via topic patterns ("issue:*", "chat:123").
     * Separated from audience so an event is emitted once and pattern-matched.
     */
    topic: text('topic'),
    /**
     * Who may see this event — the crew-access facet. "public" = everyone,
     * "members" = crew members only. Every row knows its crew; access is
     * enforced separately from topic matching.
     */
    audience: text('audience'),
    /** Who caused it, if anyone — a users.id. Null for system-originated events. */
    actorId: text('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The full event body. Lives in the row; pg_notify carries only {id,type,topic,audience}. */
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The stream replays by id range within a topic pattern.
    index('events_topic_id_idx').on(table.topic, table.id),
  ],
)

export type EventRow = typeof events.$inferSelect
