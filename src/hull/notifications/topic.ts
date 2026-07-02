/**
 * The ship-log topic namespace for notifications — the one piece of the
 * contract the BROWSER needs (the Inbox subscribes to its own user's topic).
 * A node-free leaf, like issues/topic.ts, so routes can import the namespace
 * without dragging server-only code into the client bundle.
 */

/** The prefix every notification topic carries. The single source of the namespace. */
export const NOTIFY_TOPIC_PREFIX = 'notify:'

/**
 * The ship-log topic one user's notification events ride — private to that
 * user (the visibility gate admits only the user themself).
 */
export function notifyTopic(userId: string): string {
  return `${NOTIFY_TOPIC_PREFIX}${userId}`
}

/** The user id a topic refers to, or null if it isn't a notification topic. */
export function userIdFromNotifyTopic(topic: string): string | null {
  return topic.startsWith(NOTIFY_TOPIC_PREFIX)
    ? topic.slice(NOTIFY_TOPIC_PREFIX.length)
    : null
}
