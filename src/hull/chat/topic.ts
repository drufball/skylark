/**
 * The ship-log topic namespace for chats — the one piece of the chat contract
 * the BROWSER needs (the chat route subscribes to one chat's topic). A node-free
 * leaf, like issues/topic.ts, so routes can import the namespace without dragging
 * server-only code (node:crypto, pi-agent-core's Buffer-touching truncate util)
 * into the client bundle.
 *
 * Both sides import the namespace from here — the server emitter (service.ts,
 * orchestrator.ts) and the client subscribers (the chat route) — so the `chat:`
 * prefix has exactly one home and can't drift between them.
 */

/** The prefix every chat topic carries. The single source of the namespace. */
export const CHAT_TOPIC_PREFIX = 'chat:'

/**
 * The ship-log topic a chat's events ride on; members subscribe to it.
 */
export function chatTopic(chatId: string): string {
  return `${CHAT_TOPIC_PREFIX}${chatId}`
}

/**
 * The chat id a topic refers to, or null if it isn't a chat topic — the inverse
 * of `chatTopic`. So entitlement code asks chat "is this yours, and whose?"
 * rather than re-deriving the `chat:` format and drifting from it.
 */
export function chatIdFromTopic(topic: string): string | null {
  return topic.startsWith(CHAT_TOPIC_PREFIX)
    ? topic.slice(CHAT_TOPIC_PREFIX.length)
    : null
}

/** The event a posted message announces (one name for emitter + subscriber). */
export const CHAT_MESSAGE_POSTED = 'chat.message_posted'

/**
 * The event the chat orchestrator emits while an agent is working on a reply
 * (progress lines riding the ship's log, rendered as a "working…" placeholder
 * in the UI until the message_posted event replaces it with the real message).
 */
export const CHAT_AGENT_PROGRESS = 'chat.agent_progress'

/**
 * The payload shape for `chat.agent_progress` events — which chat, which agent,
 * and the current progress line (e.g., "reading memory" or "calling tool: bash").
 */
export interface ChatAgentProgressPayload {
  chatId: string
  agentUserId: string
  line: string
}
