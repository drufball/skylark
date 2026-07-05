import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

import { users } from '@hull/users/schema'

// Real login: a password per human, and the browser sessions it hands out.
// Deliberately split from `users` — that table is read constantly (@mentions,
// crew listings) and shouldn't carry secrets. Both tables are RLS-enabled with
// NO policies (migration 0021), so they're reachable only via `systemDb` —
// resolving "who is this request?" has to happen BEFORE an actor (and RLS
// context) exists, so it's fixed system plumbing, same category as seeding.

/** A human's password, one row per user. Agents never get one. */
export const credentials = pgTable('credentials', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  /** scrypt, `<salt-hex>:<hash-hex>` — see auth/service.ts hashPassword. */
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/** A logged-in browser session. The cookie holds the raw token; only its hash
 * lives here, so a database leak can't be replayed as a live session. */
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
