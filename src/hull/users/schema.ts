import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

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

  // --- Agent config: how an agent's sessions boot. Null/irrelevant for
  // humans. Each agent user row carries its own full recipe — there is no
  // shared profile table to point at (see hull/agent/zine.md).

  /** System prompt for the agent. Null = pi.dev's default system prompt. */
  systemPrompt: text('system_prompt'),
  /**
   * Allowlist of tool names, e.g. ['read','bash']. Null means "the default
   * coding tools" (read/bash/edit/write) — the builder's full toolset.
   */
  tools: jsonb('tools').$type<string[] | null>(),
  /** Whether to feed the ship's CLAUDE.md to the agent. */
  readContextFiles: boolean('read_context_files').notNull().default(true),
  /** Whether to load the repo's skill directories. */
  useRepoSkills: boolean('use_repo_skills').notNull().default(true),
  /** Extension ids (→ extensions.id) to load for this agent's sessions. */
  extensionIds: jsonb('extension_ids').$type<string[]>().notNull().default([]),
  /** Optional model id override, e.g. "claude-opus-4-5". Null = session/default. */
  model: text('model'),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type UserRow = typeof users.$inferSelect
