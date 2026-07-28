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

/**
 * The pattern matching every user's notification topic — what a surface asks for
 * when it can't name the viewer, which is the `inbox` widget's situation: a
 * widget's live topics are derived from its PROPS, and an inbox widget's props
 * deliberately can't name a person.
 *
 * Asking for the wildcard is not asking to see everyone's inbox. A topic pattern
 * says what the client asked for; `canSeeTopic` says what it's allowed, and for
 * `notify:<userId>` it admits exactly that user — so two members looking at one
 * widget row each hear only their own. (See hull/access/visibility.ts: the topic
 * IS the entitlement here, with no probe needed.)
 */
export const NOTIFY_TOPIC_PATTERN = `${NOTIFY_TOPIC_PREFIX}*`

/** The user id a topic refers to, or null if it isn't a notification topic. */
export function userIdFromNotifyTopic(topic: string): string | null {
  return topic.startsWith(NOTIFY_TOPIC_PREFIX)
    ? topic.slice(NOTIFY_TOPIC_PREFIX.length)
    : null
}
