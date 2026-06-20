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
  /** DEPRECATED: use topic + audience. For backward compat during migration. */
  scope?: string
  /** The entity stream (e.g. "issue:123", "chat:456"). */
  topic?: string
  /** Who may see this ("public" | "members"). */
  audience?: string
  /** Who caused it — a users.id. Null/omitted for system-originated events. */
  actorId?: string | null
  payload: unknown
}

/**
 * Append one event to the log. The id is a fresh UUIDv7, so it's both the
 * primary key and the stream cursor — later events sort after earlier ones by
 * id alone. Supports both old (scope) and new (topic + audience) schemas during
 * migration. If topic/audience are provided, they take precedence.
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
      scope: input.scope ?? null,
      topic: input.topic ?? null,
      audience: input.audience ?? null,
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
 * Events matching topic patterns and audience access, oldest first — the reconnect
 * replay. `sinceId` is a Last-Event-ID cursor: only events with a strictly greater
 * id come back (UUIDv7 ids are monotonic, so "greater" means "later").
 *
 * Supports both old (scopes) and new (topicPatterns + audience) APIs during migration.
 */
export async function listEventsSince(
  db: Database,
  opts: {
    scopes?: string[]
    topicPatterns?: string[]
    audience?: string
    viewerId?: string
    sinceId?: string
    limit?: number
  },
): Promise<EventRow[]> {
  // Old API: use scopes
  if (opts.scopes !== undefined) {
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

  // New API: use topic patterns + audience
  const patterns = opts.topicPatterns ?? []
  if (patterns.length === 0) return []

  // For now, fetch all events and filter in-memory for pattern matching.
  // In production, we'd optimize with better indexing or pattern-specific queries.
  const conditions = []
  if (opts.sinceId) conditions.push(gt(events.id, opts.sinceId))

  const allEvents = await db
    .select()
    .from(events)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(events.id))
    .limit(opts.limit ?? REPLAY_PAGE_SIZE)

  // Filter by topic pattern and audience
  return allEvents.filter((event) => {
    // Check topic pattern match
    const topicMatch = patterns.some((pattern) =>
      matchesTopic(event.topic ?? event.scope ?? '', pattern),
    )
    if (!topicMatch) return false

    // Check audience match: if an audience filter is specified, only return
    // events with that exact audience
    if (opts.audience && event.audience) {
      if (event.audience !== opts.audience) return false
      return canViewAudience(event.audience, opts.viewerId ?? '')
    }
    return true
  })
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

/**
 * Does a topic match a pattern? Supports wildcards ("*") for pattern matching.
 * - Exact match: "issue:123" matches "issue:123"
 * - Wildcard: "issue:123" matches "issue:*"
 * - Multi-segment: "issue:123:comment" matches "issue:*" and "issue:*:comment"
 */
export function matchesTopic(topic: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern === topic) return true

  const topicParts = topic.split(':')
  const patternParts = pattern.split(':')

  // If pattern has more segments than topic, it can't match
  if (patternParts.length > topicParts.length) return false

  // Check each segment
  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i]
    const topicPart = topicParts[i]

    if (patternPart === '*') {
      // Wildcard matches rest of the topic if it's the last pattern segment
      if (i === patternParts.length - 1) return true
      // Otherwise just this segment
      continue
    }

    if (patternPart !== topicPart) return false
  }

  return true
}

/** The audience everyone can see. */
export const PUBLIC_AUDIENCE = 'public'

/** The audience only crew members can see. */
export const MEMBERS_AUDIENCE = 'members'

/**
 * May a viewer see an event with this audience? Access control for events.
 * - public: everyone can see
 * - members: only authenticated crew members (for now, anyone authenticated)
 */
export function canViewAudience(
  audience: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _viewerId?: string,
): boolean {
  // For now, treat all authenticated users as members (single-crew).
  // This will be enhanced with the crew-filter primitive.
  // _viewerId will be used when the crew-filter enforcement lands.
  if (audience === PUBLIC_AUDIENCE) return true
  if (audience === MEMBERS_AUDIENCE) return true
  return false
}
