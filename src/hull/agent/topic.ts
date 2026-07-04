/**
 * The ship-log topic namespace for agent sessions — the one piece of the agent
 * contract the BROWSER needs (the agents route subscribes to one session's topic).
 * A node-free leaf, like issues/topic.ts, so routes can import the namespace
 * without dragging the pi-wired runtime (which probes the credential store at
 * module load) into the client bundle.
 *
 * Both sides import the namespace from here — the server emitter (runtime.ts)
 * and the client subscribers (the agents route) — so the `session:` prefix has
 * exactly one home and can't drift between them.
 */

/** The prefix every session topic carries. The single source of the namespace. */
export const SESSION_TOPIC_PREFIX = 'session:'

/**
 * The ship-log topic every event for a session is published under.
 */
export function sessionTopic(sessionId: string): string {
  return `${SESSION_TOPIC_PREFIX}${sessionId}`
}

/**
 * The session id a topic refers to, or null if it isn't a session topic — the
 * inverse of `sessionTopic`, so entitlement code asks the agent service "whose
 * session is this?" rather than re-deriving the `session:` format.
 */
export function sessionIdFromTopic(topic: string): string | null {
  return topic.startsWith(SESSION_TOPIC_PREFIX)
    ? topic.slice(SESSION_TOPIC_PREFIX.length)
    : null
}
