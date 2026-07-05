import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

import { uuidv7 } from '@earendil-works/pi-agent-core'
import { and, eq, gt } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import {
  createUser,
  getUserByHandle,
  getUserById,
  validateHandle,
} from '@hull/users/service'
import type { UserRow } from '@hull/users/schema'

import { credentials, sessions } from './schema'

type CredentialsRow = typeof credentials.$inferSelect

/**
 * Real accounts for the crew: password hashing (Node's own scrypt — no
 * dependency to pull in), sessions, and the signup rule. Every function here
 * takes its own `Database`, same as every other service — the impure edges
 * (reading/writing the session cookie, choosing systemDb) live in
 * users/actor.ts and this service's server.ts door.
 */

const scrypt = promisify(scryptCb)
const SCRYPT_KEY_LENGTH = 64

/** `<salt-hex>:<hash-hex>` — the salt travels with the hash, as usual for scrypt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

/** Constant-time compare against a stored `hashPassword` value. A malformed
 * stored hash (never should happen — defense in depth) fails rather than throws. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const hash = Buffer.from(hashHex, 'hex')
  const derived = (await scrypt(password, salt, hash.length)) as Buffer
  return derived.length === hash.length && timingSafeEqual(derived, hash)
}

/** The raw value that becomes the session cookie. Never stored — only its hash is. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** How a raw session token is stored/looked-up, so a database leak can't be
 * replayed as a live session. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The cookie a logged-in browser carries; names a real, revocable session. */
export const SESSION_COOKIE = 'skylark_session'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Start a session for `userId`, returning the raw token — the only place it
 * exists outside the caller's cookie. */
export async function createSession(
  db: Database,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.insert(sessions).values({
    id: uuidv7(),
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  })
  return { token, expiresAt }
}

type SessionRow = typeof sessions.$inferSelect

/** The live (unexpired) session row for a raw token, if any. An explicitly
 * annotated return type — same as chat's `getChat` — is what lets callers
 * branch on "found or not"; TS can't see the emptiness of a bare destructured
 * select on its own. */
async function getLiveSession(
  db: Database,
  token: string,
): Promise<SessionRow | undefined> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
      ),
    )
  return row
}

/** Resolve a raw session token to its user, or undefined if it's unknown or expired. */
export async function getSessionUser(
  db: Database,
  token: string,
): Promise<UserRow | undefined> {
  const session = await getLiveSession(db, token)
  if (!session) return undefined
  return getUserById(db, session.userId)
}

/** End a session. Deleting an unknown token is a no-op, not an error. */
export async function deleteSession(
  db: Database,
  token: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}

/** The stored credentials for a user, if they have any yet (a seeded human row
 * has none until signup/setPassword gives it one). Explicitly annotated
 * return type for the same reason as `getLiveSession`. */
async function getCredentials(
  db: Database,
  userId: string,
): Promise<CredentialsRow | undefined> {
  const [row] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, userId))
  return row
}

/** Check a handle + password against stored credentials. Undefined for any
 * failure (unknown handle, no credentials, wrong password) — never
 * distinguishes which, so a login form can't be used to enumerate handles. */
export async function verifyLogin(
  db: Database,
  handle: string,
  password: string,
): Promise<UserRow | undefined> {
  const user = await getUserByHandle(db, handle)
  if (!user) return undefined
  const cred = await getCredentials(db, user.id)
  if (!cred) return undefined
  return (await verifyPassword(password, cred.passwordHash)) ? user : undefined
}

/**
 * Set (or overwrite) a user's password directly, no invite code — the CLI
 * recovery path for a server you already have trusted shell access to,
 * standing in for the email/forgot-password flow this app doesn't have.
 */
export async function setPassword(
  db: Database,
  userId: string,
  password: string,
): Promise<void> {
  const passwordHash = await hashPassword(password)
  await db
    .insert(credentials)
    .values({ userId, passwordHash })
    .onConflictDoUpdate({ target: credentials.userId, set: { passwordHash } })
}

export const MIN_PASSWORD_LENGTH = 8

/**
 * Create a real account, gated by the invite secret (`expectedInviteCode` —
 * the caller reads it from `SKYLARK_INVITE_CODE`; undefined means signups
 * aren't configured, so every attempt fails closed). Claims an existing
 * passwordless human row by handle if one exists (how the operator seeded by
 * `seedCrew` — captain, by default — gets a password without losing the id
 * their existing data points at); otherwise creates a fresh human user.
 */
export async function signup(
  db: Database,
  input: { handle: string; password: string; inviteCode: string },
  expectedInviteCode: string | undefined,
): Promise<UserRow> {
  if (!expectedInviteCode || input.inviteCode !== expectedInviteCode) {
    throw new Error('Invalid invite code')
  }
  const handle = validateHandle(input.handle)
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`,
    )
  }

  const existing = await getUserByHandle(db, handle)
  if (existing && existing.type !== 'human') {
    throw new Error(`@${handle} belongs to an agent, not a human`)
  }
  if (existing && (await getCredentials(db, existing.id))) {
    throw new Error(`Handle @${handle} is taken`)
  }

  const user =
    existing ??
    (await createUser(db, {
      id: uuidv7(),
      handle,
      displayName: handle.charAt(0).toUpperCase() + handle.slice(1),
      type: 'human',
    }))
  await db.insert(credentials).values({
    userId: user.id,
    passwordHash: await hashPassword(input.password),
  })
  return user
}
