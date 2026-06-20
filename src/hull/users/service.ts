import { uuidv7 } from '@earendil-works/pi-agent-core'
import { asc, eq } from 'drizzle-orm'

import type { Database } from '@hull/db/client'

import { users, type UserRow } from './schema'

/**
 * Pure persistence logic for the users service — the crew aboard the ship. Like
 * every service it's database-agnostic: hand it any drizzle database (live
 * Postgres, or PGlite in tests) and it touches only its own `users` table. The
 * cookie/env reading that picks *who the actor is* lives in actor.ts, the thin
 * impure edge; the rule it follows (resolveActorHandle) is here and unit-tested.
 */

export type UserType = UserRow['type']

export async function createUser(
  db: Database,
  input: {
    id: string
    handle: string
    displayName: string
    type: UserType
    profileId?: string
  },
): Promise<UserRow> {
  const [row] = await db.insert(users).values(input).returning()
  return row
}

export async function getUserById(
  db: Database,
  id: string,
): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id))
  return row
}

export async function getUserByHandle(
  db: Database,
  handle: string,
): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.handle, handle))
  return row
}

/** Everyone aboard, oldest first (UUIDv7 ids are time-ordered). */
export async function listUsers(db: Database): Promise<UserRow[]> {
  return db.select().from(users).orderBy(asc(users.id))
}

/** The crew every fresh ship is seeded with: the operator plus the three agents. */
export const SEED_CREW: readonly {
  handle: string
  displayName: string
  type: UserType
}[] = [
  { handle: 'drufball', displayName: 'Dru', type: 'human' },
  { handle: 'tilde', displayName: 'Tilde', type: 'agent' },
  { handle: 'bix', displayName: 'Bix', type: 'agent' },
  { handle: 'dot', displayName: 'Dot', type: 'agent' },
]

/**
 * Seed the standard crew, idempotently: insert any missing handle, leave
 * existing rows untouched (so a hand-edited displayName or id survives). Safe to
 * run on a fresh database or an established one, any number of times.
 */
export async function seedCrew(db: Database): Promise<void> {
  for (const member of SEED_CREW) {
    const existing = await getUserByHandle(db, member.handle)
    if (existing) continue
    await createUser(db, { id: uuidv7(), ...member })
  }
}

/**
 * Which user handle is the actor, given the ambient inputs? The rule, kept pure
 * so it's trivially testable:
 * - **web**: a dev cookie override (test as a different human) wins, else the
 *   configured operator.
 * - **cli**: the operator only — the cookie is a browser concept and is ignored
 *   so a stray cookie can never change who the CLI acts as. (The CLI's own
 *   explicit identity override, SKYLARK_ACTOR, is a userId handled in actor.ts,
 *   upstream of this handle resolution.)
 */
export function resolveActorHandle(input: {
  context: 'web' | 'cli'
  cookieHandle: string | undefined
  operator: string
}): string {
  if (input.context === 'web' && input.cookieHandle) return input.cookieHandle
  return input.operator
}
