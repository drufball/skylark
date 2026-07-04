import { uuidv7 } from '@earendil-works/pi-agent-core'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import {
  emitEvent,
  type NotifyPayload,
  type ShipLogReactor,
} from '@hull/events/bus'
import {
  getEventById,
  listEventsSince,
  MEMBERS_AUDIENCE,
  PUBLIC_AUDIENCE,
  REPLAY_PAGE_SIZE,
} from '@hull/events/service'
import {
  ISSUE_COMMENTED,
  ISSUE_OPENED,
  ISSUE_STATUS_CHANGED,
} from '@hull/issues/service'
import { ISSUE_HANDOFF, ISSUE_OWNER_PING } from '@hull/issues/handoff'
import {
  ISSUE_TOPIC_PATTERN,
  ISSUE_TOPIC_PREFIX,
  issueTopic,
} from '@hull/issues/topic'
import { errorMessage } from '@hull/lib/errors'
import { firstLine, truncate } from '@hull/lib/text'

import { notifications, watches, type NotificationRow } from './schema'
import { notifyTopic } from './topic'

/**
 * Every user's inbox, fed by watches. A watch says "tell <user> when something
 * happens on <topic>"; the reactor below listens to the ship's log and turns
 * watched durable events into inbox rows. One mechanism for everyone: humans
 * read theirs on the Inbox surface, and an agent's notifications wake it.
 *
 * Watches are earned two ways: explicitly (the Watch button), and by ACTING —
 * whoever causes an event on an auto-watch topic (files an issue, comments,
 * moves status) is subscribed to that topic from then on. That one rule covers
 * "creators are notified" and "commenting watches" without special cases.
 *
 * Each inbox row is announced as `notification.created` on the owner's private
 * `notify:<userId>` topic (the visibility gate admits only the owner), which is
 * what makes the bell live.
 */

/** The event announcing a new inbox row (on the owner's notify:<id> topic). */
export const NOTIFICATION_CREATED = 'notification.created'

/**
 * Should acting on this topic subscribe the actor to it? Issues, for now:
 * filing, commenting, or moving one means you care where it goes. Chat topics
 * stay out — chat has its own surface and would drown the inbox.
 */
export function isAutoWatchTopic(topic: string): boolean {
  return topic.startsWith(ISSUE_TOPIC_PREFIX)
}

/**
 * One line of inbox copy for a notification, from what the row itself carries.
 * Pure — the door resolves the actor's handle and hands it in. Falls back to
 * "type on topic" for event types this doesn't know, so an unknown event is
 * still legible rather than blank.
 */
export function describeNotification(input: {
  type: string
  topic: string
  payload: unknown
  actorHandle: string
}): string {
  const { type, topic, actorHandle } = input
  const payload = input.payload as {
    title?: unknown
    from?: unknown
    to?: unknown
    toHandle?: unknown
    toOwner?: unknown
    message?: unknown
  }
  switch (type) {
    case ISSUE_OPENED:
      return typeof payload.title === 'string'
        ? `@${actorHandle} opened "${payload.title}"`
        : `@${actorHandle} opened an issue`
    case ISSUE_COMMENTED:
      return `@${actorHandle} commented`
    case ISSUE_STATUS_CHANGED:
      return typeof payload.from === 'string' && typeof payload.to === 'string'
        ? `@${actorHandle} moved it: ${payload.from} → ${payload.to}`
        : `@${actorHandle} changed the status`
    case ISSUE_HANDOFF: {
      // Baton pass between agents.
      const brief =
        typeof payload.message === 'string'
          ? truncate(firstLine(payload.message), 160)
          : ''
      const toHandle =
        typeof payload.toHandle === 'string' ? payload.toHandle : '?'
      return `@${actorHandle} passed the baton to @${toHandle}: ${brief}`
    }
    case ISSUE_OWNER_PING: {
      // Owner ping for review/decision.
      const brief =
        typeof payload.message === 'string'
          ? truncate(firstLine(payload.message), 160)
          : ''
      const toHandle =
        typeof payload.toHandle === 'string' ? payload.toHandle : '?'
      return `@${actorHandle} needs @${toHandle} (the owner) to look: ${brief}`
    }
    default:
      return `${type} on ${topic}`
  }
}

// --- Watches ----------------------------------------------------------------

export async function watchTopic(
  db: Database,
  userId: string,
  topic: string,
): Promise<void> {
  await db.insert(watches).values({ userId, topic }).onConflictDoNothing()
}

export async function unwatchTopic(
  db: Database,
  userId: string,
  topic: string,
): Promise<void> {
  await db
    .delete(watches)
    .where(and(eq(watches.userId, userId), eq(watches.topic, topic)))
}

export async function isWatching(
  db: Database,
  userId: string,
  topic: string,
): Promise<boolean> {
  const rows = await db
    .select({ userId: watches.userId })
    .from(watches)
    .where(and(eq(watches.userId, userId), eq(watches.topic, topic)))
  return rows.length > 0
}

/** Everyone subscribed to a topic. */
export async function listWatchers(
  db: Database,
  topic: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: watches.userId })
    .from(watches)
    .where(eq(watches.topic, topic))
  return rows.map((r) => r.userId)
}

// --- The inbox ----------------------------------------------------------------

/**
 * Put one entry in a user's inbox and announce it on their private notify
 * topic. Idempotent per (user, source event): a duplicate delivery — a bus
 * replay, a second process's reactor — is a no-op returning null: no second
 * row, no second bell. The announcement carries the row's essentials so a
 * live subscriber can update without a read-back.
 */
export async function addNotification(
  db: Database,
  input: {
    userId: string
    eventId: string
    type: string
    topic: string
    payload: unknown
    actorId: string | null
  },
): Promise<NotificationRow | null> {
  // .at(0) rather than destructuring: on conflict the returned array is EMPTY,
  // and .at() carries the `| undefined` that fact needs in its type.
  const row = (
    await db
      .insert(notifications)
      .values({ id: uuidv7(), ...input })
      .onConflictDoNothing()
      .returning()
  ).at(0)
  if (!row) return null
  await emitEvent(db, {
    type: NOTIFICATION_CREATED,
    source: 'notifications',
    topic: notifyTopic(input.userId),
    audience: MEMBERS_AUDIENCE,
    actorId: input.actorId,
    payload: { notificationId: row.id, type: input.type, topic: input.topic },
  })
  return row
}

/** A user's inbox, newest first. */
export async function listNotifications(
  db: Database,
  userId: string,
  limit = 100,
): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.id))
    .limit(limit)
}

/** The user's unread entries, oldest first — what an agent wake-up consumes. */
export async function listUnread(
  db: Database,
  userId: string,
): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .orderBy(notifications.id)
}

/**
 * All unread notifications across all users.
 * Used by reconcile to re-deliver notifications that might have been created
 * during a reload (when hooks weren't registered). No age filter: if a
 * notification is unread, it was never delivered to the waker, so it should
 * be re-delivered regardless of age.
 */
export async function listAllUnread(db: Database): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(isNull(notifications.readAt))
    .orderBy(notifications.id)
}

export async function unreadCount(
  db: Database,
  userId: string,
): Promise<number> {
  return (await listUnread(db, userId)).length
}

export async function markAllRead(db: Database, userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
}

/** Mark specific entries read — the waker consumes exactly what it delivered. */
export async function markRead(
  db: Database,
  userId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.userId, userId), inArray(notifications.id, ids)),
    )
}

/**
 * Fan one delivered notification out to every registered delivery hook (the
 * live wiring's "beyond the inbox row" channels — e.g. the agent waker), each
 * hook isolated: one broken delivery channel must not silence the others.
 * Failures are logged, never thrown — the inbox row is already durable.
 */
export function deliverToHooks(
  hooks: readonly ((notification: NotificationRow) => void)[],
  notification: NotificationRow,
): void {
  for (const hook of hooks) {
    try {
      hook(notification)
    } catch (err) {
      console.error(`notification hook failed: ${errorMessage(err)}`)
    }
  }
}

// --- The reactor ---------------------------------------------------------------

/**
 * The fan-out: reacts to every durable ship-log event. The event's actor is
 * auto-subscribed to auto-watch topics (acting = caring), then every OTHER
 * watcher of the topic gets an inbox entry. Runs on systemDb in the live
 * wiring — it writes inbox rows across users, which RLS rightly forbids any
 * single actor from doing.
 *
 * `onNotified` is the delivery hook beyond the inbox itself: the live wiring
 * uses it to wake agents. Injected so this stays testable without a runtime.
 */
export function createNotificationsReactor(deps: {
  db: Database
  onNotified?: (notification: NotificationRow) => void
}): ShipLogReactor {
  const { db } = deps

  async function handleBusNote(note: NotifyPayload): Promise<void> {
    // Transient UI events never notify, and our own announcements must not
    // fan out again (that way lies an infinite loop).
    if (note.ephemeral) return
    if (note.type === NOTIFICATION_CREATED) return

    const event = await getEventById(db, note.id)
    if (!event?.topic) return
    // Only public events fan out. A members-scoped event (a chat message, a
    // session delta) must not reach someone through a watch row they planted
    // on a topic they can't see.
    if (event.audience && event.audience !== PUBLIC_AUDIENCE) return

    if (event.actorId && isAutoWatchTopic(event.topic)) {
      await watchTopic(db, event.actorId, event.topic)
    }
    // An issue opened for another owner watches that owner from the start —
    // they answer for the work, so they hear where it goes without ever
    // having to act on it first.
    if (event.type === ISSUE_OPENED && isAutoWatchTopic(event.topic)) {
      const ownerId = (event.payload as { ownerId?: unknown }).ownerId
      if (typeof ownerId === 'string') {
        await watchTopic(db, ownerId, event.topic)
      }
    }

    // Handoffs adjust the recipients around the watch list: an OWNER ping must
    // reach the owner even if they never watched, and a baton pass must NOT
    // also land in the target's inbox — the issues orchestrator is already
    // driving them a turn, and an inbox wake on top would double-drive. The
    // payload is only honored when it agrees with the event's own topic: a
    // forged row naming a foreign issueId doesn't get to pick recipients.
    const recipients = new Set(await listWatchers(db, event.topic))
    if (event.type === ISSUE_HANDOFF) {
      // Baton pass: remove the target from watchers (they're being driven a turn)
      const p = event.payload as {
        issueId?: unknown
        toUserId?: unknown
        toOwner?: unknown // compatibility: old events may have this
      }
      if (
        typeof p.toUserId === 'string' &&
        typeof p.issueId === 'string' &&
        event.topic === issueTopic(p.issueId)
      ) {
        // Compatibility: old issue.handoff events with toOwner=true should be
        // treated as owner pings (add to recipients), not baton passes
        if (p.toOwner === true) recipients.add(p.toUserId)
        else recipients.delete(p.toUserId)
      }
    }
    if (event.type === ISSUE_OWNER_PING) {
      // Owner ping: add the target to watchers (inbox + agent wake)
      const p = event.payload as {
        issueId?: unknown
        toUserId?: unknown
      }
      if (
        typeof p.toUserId === 'string' &&
        typeof p.issueId === 'string' &&
        event.topic === issueTopic(p.issueId)
      ) {
        recipients.add(p.toUserId)
      }
    }

    for (const watcher of recipients) {
      if (watcher === event.actorId) continue // your own action isn't news
      const row = await addNotification(db, {
        userId: watcher,
        eventId: event.id,
        type: event.type,
        topic: event.topic,
        payload: event.payload,
        actorId: event.actorId,
      })
      if (!row) continue // already delivered (a replay) — nothing new to say
      try {
        deps.onNotified?.(row)
      } catch (err) {
        // Delivery beyond the inbox is best-effort; the row is already durable.
        console.error(`notification delivery failed: ${errorMessage(err)}`)
      }
    }
  }

  /**
   * Startup recovery: replay the durable issue events and re-apply the
   * acting-auto-watches, so an issue filed while no reactor was subscribed
   * (a fresh process, a CLI hit before any door) still ends up watched by its
   * actors — a watch is durable intent and must not be lost.
   *
   * Also re-delivers ALL unread notifications through the onNotified hook:
   * if the reactor created a notification row during a Vite reload window
   * (before the hook was registered or while the waker's timer was lost),
   * reconcile gives the hook another chance. This is the #l0di fix: the waker
   * rides onNotified, and without re-delivery, notifications created during
   * reload sit unread forever with no wake.
   *
   * No age filter: if a notification is unread, it was never delivered to the
   * waker, so it should be re-delivered regardless of age. Stranding old
   * unread notifications would be the same wake-loss bug this PR fixes, just
   * time-shifted.
   */
  async function reconcile(): Promise<void> {
    // Replay watches from the durable log
    let sinceId: string | undefined
    for (;;) {
      const page = await listEventsSince(db, {
        topicPatterns: [ISSUE_TOPIC_PATTERN],
        audience: PUBLIC_AUDIENCE,
        sinceId,
      })
      for (const event of page) {
        sinceId = event.id
        if (event.actorId && event.topic && isAutoWatchTopic(event.topic)) {
          await watchTopic(db, event.actorId, event.topic)
        }
        // Owner watches are durable intent too: an issue opened for a distinct
        // owner while no reactor was subscribed still ends up watched by them.
        if (
          event.type === ISSUE_OPENED &&
          event.topic &&
          isAutoWatchTopic(event.topic)
        ) {
          const ownerId = (event.payload as { ownerId?: unknown }).ownerId
          if (typeof ownerId === 'string') {
            await watchTopic(db, ownerId, event.topic)
          }
        }
      }
      if (page.length < REPLAY_PAGE_SIZE) break
    }

    // Re-deliver ALL unread notifications through the hook (reload recovery)
    const unread = await listAllUnread(db)
    for (const notification of unread) {
      try {
        deps.onNotified?.(notification)
      } catch (err) {
        // Delivery is best-effort; the row is already durable.
        console.error(
          `reconcile notification delivery failed: ${errorMessage(err)}`,
        )
      }
    }
  }

  return { handleBusNote, reconcile }
}
