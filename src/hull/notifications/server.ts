import { createServerFn } from '@tanstack/react-start'

import { issueIdFromTopic } from '@hull/issues/topic'
import { withCurrentActor } from '@hull/users/actor'
import { handleOf } from '@hull/users/service'

import { ensureNotificationsReactor } from './live'
import {
  describeNotification,
  isWatching,
  listNotifications,
  markAllRead,
  unreadCount,
  unwatchTopic,
  watchTopic,
} from './service'

// The web doors onto the notifications service. Every door runs under the
// current actor's RLS context, so the inbox and watch tables scope themselves
// (the policies in migration 0010 are the gate). Each door also ensures the
// fan-out reactor is subscribed in this process, so notifications flow the
// moment anyone looks.

/**
 * A topic the crew may watch through the web door: issues only for now — they
 * are public, so a watch can't be used to siphon events the watcher couldn't
 * see. (The reactor independently refuses to fan out non-public events.)
 * Parsed with the issues topic grammar, so a bare "issue:" doesn't pass.
 */
function parseWatchableTopic(input: unknown): string {
  if (typeof input !== 'string' || !issueIdFromTopic(input)) {
    throw new Error('Only issue topics can be watched')
  }
  return input
}

/** One inbox entry as the view shows it. */
export interface InboxItem {
  id: string
  label: string
  /** The issue this concerns, when the topic is an issue's — the click target. */
  issueId: string | null
  at: string
  read: boolean
}

/** The current actor's inbox: who they are, the entries, the unread count. */
export const myInbox = createServerFn({ method: 'GET' }).handler(async () => {
  ensureNotificationsReactor()
  return withCurrentActor(async (tx, me) => {
    const rows = await listNotifications(tx, me.id)
    const items: InboxItem[] = await Promise.all(
      rows.map(async (n) => ({
        id: n.id,
        label: describeNotification({
          type: n.type,
          topic: n.topic,
          payload: n.payload,
          actorHandle: await handleOf(tx, n.actorId),
        }),
        issueId: issueIdFromTopic(n.topic),
        at: n.createdAt.toISOString(),
        read: n.readAt !== null,
      })),
    )
    return {
      me: { id: me.id, handle: me.handle },
      items,
      unread: await unreadCount(tx, me.id),
    }
  })
})

/** Mark the current actor's whole inbox read. */
export const markInboxRead = createServerFn({ method: 'POST' }).handler(() =>
  withCurrentActor(async (tx, me) => {
    await markAllRead(tx, me.id)
    return { ok: true }
  }),
)

/** Is the current actor watching this topic? */
export const watchState = createServerFn({ method: 'GET' })
  .validator(parseWatchableTopic)
  .handler(({ data: topic }) => {
    ensureNotificationsReactor()
    return withCurrentActor(async (tx, me) => ({
      watching: await isWatching(tx, me.id, topic),
    }))
  })

/** Watch or unwatch a topic as the current actor. */
export const setWatch = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const record = input as { topic?: unknown; watching?: unknown }
    if (typeof record.watching !== 'boolean')
      throw new Error('watching must be a boolean')
    return {
      topic: parseWatchableTopic(record.topic),
      watching: record.watching,
    }
  })
  .handler(({ data }) => {
    ensureNotificationsReactor()
    return withCurrentActor(async (tx, me) => {
      if (data.watching) await watchTopic(tx, me.id, data.topic)
      else await unwatchTopic(tx, me.id, data.topic)
      return { watching: data.watching }
    })
  })
