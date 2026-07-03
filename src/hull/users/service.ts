import { uuidv7 } from '@earendil-works/pi-agent-core'
import { and, asc, eq, isNull } from 'drizzle-orm'

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

/** The fallback handle when an id resolves to no user (a deleted/unknown actor). */
export const UNKNOWN_HANDLE = '?'

/**
 * Resolve a user id to a display handle, defaulting to `?` when there's no row.
 * The "an actorId/authorId becomes a handle, or `?`" policy lived open-coded in
 * several call sites; this is its one home. A null id (a system-originated
 * event with no actor) also resolves to `?`.
 */
export async function handleOf(
  db: Database,
  id: string | null,
): Promise<string> {
  if (!id) return UNKNOWN_HANDLE
  const user = await getUserById(db, id)
  return user?.handle ?? UNKNOWN_HANDLE
}

/**
 * Validate a new crew handle. Handles are @mentioned in chat and parsed with
 * `\w+` (lowercased) — see chat's parseMentions — so only lowercase word
 * characters survive the round trip. Returns the handle unchanged when valid.
 */
export function validateHandle(handle: string): string {
  if (!/^[a-z0-9_]+$/.test(handle)) {
    throw new Error(
      `Invalid handle "${handle}" — lowercase letters, digits, and _ only`,
    )
  }
  return handle
}

/**
 * Update a named AGENT's mutable fields; undefined leaves a field alone.
 * Scoped to agents at the query so a human row can never be renamed or handed
 * an agent profile through this path — a human target reads as not-found.
 */
export async function updateAgentUser(
  db: Database,
  userId: string,
  patch: { displayName?: string; profileId?: string },
): Promise<UserRow | undefined> {
  const [row] = await db
    .update(users)
    .set(patch)
    .where(and(eq(users.id, userId), eq(users.type, 'agent')))
    .returning()
  return row
}

/** Remove a user row — the compensating delete for a failed agent creation. */
export async function deleteUser(db: Database, userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId))
}

/** Point one crew member at an agent profile (by id). Writes only the users table. */
export async function setUserProfile(
  db: Database,
  userId: string,
  profileId: string,
): Promise<void> {
  await db.update(users).set({ profileId }).where(eq(users.id, userId))
}

/**
 * Give every agent crew member without a profile the supplied default profile,
 * idempotently. Humans are left alone; agents that already have a profile keep
 * it (so a hand-assigned profile survives). The agent profiles live in another
 * service, so the caller passes the id — users only ever writes its own column.
 * This is how the loose `profileId` text column gets wired once profiles exist.
 */
export async function assignDefaultAgentProfile(
  db: Database,
  profileId: string,
): Promise<void> {
  await db
    .update(users)
    .set({ profileId })
    .where(and(eq(users.type, 'agent'), isNull(users.profileId)))
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
  // The building agent: the identity M3's builder sessions act as, so their
  // issue comments and transitions show as the builder (via SKYLARK_ACTOR).
  { handle: 'builder', displayName: 'Builder', type: 'agent' },
  // The general deckhand: the `general` playbook's entrypoint — full tools, no
  // build contract, does whatever the issue says.
  { handle: 'hand', displayName: 'Hand', type: 'agent' },
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
