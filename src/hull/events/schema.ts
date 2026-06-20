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
     * Visibility key. A subscriber sees an event only if its scope is in the
     * set they're allowed to see — e.g. "session:<id>" (that conversation) or
     * "public" (everyone). The crew-aware widening of this lives with the actor.
     */
    scope: text('scope').notNull(),
    /** Who caused it, if anyone — a users.id. Null for system-originated events. */
    actorId: text('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The full event body. Lives in the row; pg_notify carries only {id,type,scope}. */
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The stream replays by id range within a scope; index both.
    index('events_scope_id_idx').on(table.scope, table.id),
  ],
)

export type EventRow = typeof events.$inferSelect
