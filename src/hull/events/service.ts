import { uuidv7 } from '@earendil-works/pi-agent-core'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'

import type { Database } from '@hull/db/client'

import { events, type EventRow } from './schema'

/**
 * Pure persistence logic for the events service — the ship's log. Like every
 * service it's database-agnostic and touches only its own `events` table.
 * Appending a row is the durable half of an emit; the impure half (pg_notify +
 * fan-out to live SSE clients) is the bus shell in bus.ts. Reading back by
 * cursor is how a reconnecting subscriber replays what it missed.
 */

/** The scope everyone can see. */
export const PUBLIC_SCOPE = 'public'

/**
 * How many events a single replay page returns at most. A reconnect catch-up
 * pages through this — the SSE route loops until a short page comes back — so a
 * long absence still loses nothing; this only bounds one round-trip.
 */
export const REPLAY_PAGE_SIZE = 500

export interface AppendEventInput {
  type: string
  source: string
  scope: string
  /** Who caused it — a users.id. Null/omitted for system-originated events. */
  actorId?: string | null
  payload: unknown
}

/**
 * Append one event to the log. The id is a fresh UUIDv7, so it's both the
 * primary key and the stream cursor — later events sort after earlier ones by
 * id alone.
 */
export async function appendEvent(
  db: Database,
  input: AppendEventInput,
): Promise<EventRow> {
  const [row] = await db
    .insert(events)
    .values({
      id: uuidv7(),
      type: input.type,
      source: input.source,
      scope: input.scope,
      actorId: input.actorId ?? null,
      payload: input.payload,
    })
    .returning()
  return row
}

/** One event by id — the SSE shell reads the full row after a tiny NOTIFY. */
export async function getEventById(
  db: Database,
  id: string,
): Promise<EventRow | undefined> {
  const [row] = await db.select().from(events).where(eq(events.id, id))
  return row
}

/**
 * Events in the given scopes, oldest first — the reconnect replay. `sinceId` is
 * a Last-Event-ID cursor: only events with a strictly greater id come back
 * (UUIDv7 ids are monotonic, so "greater" means "later"). With no scopes the
 * answer is empty by construction — a subscriber sees only what it asked for.
 */
export async function listEventsSince(
  db: Database,
  opts: { scopes: string[]; sinceId?: string; limit?: number },
): Promise<EventRow[]> {
  if (opts.scopes.length === 0) return []
  const conditions = [inArray(events.scope, opts.scopes)]
  if (opts.sinceId) conditions.push(gt(events.id, opts.sinceId))
  return db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(asc(events.id))
    .limit(opts.limit ?? REPLAY_PAGE_SIZE)
}

/**
 * May a subscriber watching `visibleScopes` see an event in `scope`? Plain set
 * membership today: you see exactly the scopes you subscribed to (the route
 * decides which scopes an actor is allowed to subscribe to). Kept as its own
 * function so the live fan-out and the replay apply the identical rule.
 */
export function isScopeVisible(
  scope: string,
  visibleScopes: string[],
): boolean {
  return visibleScopes.includes(scope)
}
