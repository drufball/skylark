import { uuidv7 } from '@earendil-works/pi-agent-core'
import { and, asc, eq, inArray } from 'drizzle-orm'

import type { Database } from '@hull/db/client'

import { users, type UserRow } from './schema'

/**
 * Pure persistence logic for the users service — the crew aboard the ship. Like
 * every service it's database-agnostic: hand it any drizzle database (live
 * Postgres, or PGlite in tests) and it touches only its own `users` table. Who
 * is acting — a real session on the web, an env var on the CLI — is resolved
 * in actor.ts (the web session lookup delegates to hull/auth/service.ts).
 */

export type UserType = UserRow['type']

/**
 * The agent-config fields a user row carries (how an agent's sessions boot);
 * all optional on write — an omitted field keeps its schema default (or, on
 * update, its current value). See hull/agent/zine.md for what each means.
 */
export interface AgentConfigFields {
  systemPrompt?: string | null
  tools?: string[] | null
  readContextFiles?: boolean
  useRepoSkills?: boolean
  extensionIds?: string[]
  model?: string | null
}

export async function createUser(
  db: Database,
  input: {
    id: string
    handle: string
    displayName: string
    type: UserType
  } & AgentConfigFields,
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

/**
 * Batch lookup by id — one query instead of N `getUserById` calls in a loop,
 * for a caller joining a list of rows to their handles (the fleet view's
 * session → agent join). Empty input short-circuits without touching the DB.
 */
export async function getUsersByIds(
  db: Database,
  ids: string[],
): Promise<UserRow[]> {
  if (ids.length === 0) return []
  return db.select().from(users).where(inArray(users.id, ids))
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
 * agent config through this path — a human target reads as not-found.
 */
export async function updateAgentUser(
  db: Database,
  userId: string,
  patch: { displayName?: string } & AgentConfigFields,
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

/**
 * The agents every fresh ship is seeded with. The human operator is NOT here —
 * their handle is the ship's own configuration (SKYLARK_OPERATOR, see
 * operatorHandle in actor.ts), so seedCrew takes it as input. Nothing personal
 * is nailed into the hull.
 */
export const SEED_AGENTS: readonly {
  handle: string
  displayName: string
  type: UserType
}[] = [
  { handle: 'tilde', displayName: 'Tilde', type: 'agent' },
  { handle: 'bix', displayName: 'Bix', type: 'agent' },
  { handle: 'dot', displayName: 'Dot', type: 'agent' },
  // The building agent: the identity M3's builder sessions act as, so their
  // issue comments and transitions show as the builder (via SKYLARK_ACTOR).
  { handle: 'builder', displayName: 'Builder', type: 'agent' },
  // The general deckhand: the `general` playbook's entrypoint — full tools, no
  // build contract, does whatever the issue says.
  { handle: 'hand', displayName: 'Hand', type: 'agent' },
  // The PR babysitter: the build playbook's second hand — takes the baton at
  // an open PR, waits on CI via the background tool, merges or hands back.
  { handle: 'babysitter', displayName: 'Babysitter', type: 'agent' },
]

/**
 * Seed the standard crew, idempotently: the operator (a human — pass
 * `operatorSeed()` from actor.ts at the impure edges) plus the standard
 * agents. Inserts any missing handle, leaves existing rows untouched (so a
 * hand-edited displayName or id survives). Safe to run on a fresh database or
 * an established one, any number of times.
 */
export async function seedCrew(
  db: Database,
  operator: { handle: string; displayName: string } = {
    handle: 'captain',
    displayName: 'Captain',
  },
): Promise<void> {
  const members = [{ ...operator, type: 'human' as UserType }, ...SEED_AGENTS]
  for (const member of members) {
    const existing = await getUserByHandle(db, member.handle)
    if (existing) continue
    await createUser(db, { id: uuidv7(), ...member })
  }
}
