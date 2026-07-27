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
 * The event the chat orchestrator emits while an agent is mid-turn — progress
 * lines riding the ship's log, rendered as a "working…" status line in the UI.
 * A **blank** line is the turn's end (see the payload), which is what takes the
 * status line back down.
 */
export const CHAT_AGENT_PROGRESS = 'chat.agent_progress'

/**
 * The payload shape for `chat.agent_progress` events — which chat, which agent,
 * and the current progress line (e.g., "thinking…" or "using bash…").
 *
 * An **empty `line` means the turn is over**: take the status line down. It has
 * to be said explicitly, because a posted message no longer implies it — an
 * agent speaks from inside its turn now, so it may post and keep working for
 * another minute, and it may finish having posted nothing at all. Without an
 * end-of-turn signal a silent turn would leave a live tab spinning forever.
 */
export interface ChatAgentProgressPayload {
  chatId: string
  agentUserId: string
  line: string
}

/**
 * The event a change to a chat's widget stack announces. It rides the chat's own
 * `chat:<id>` topic, so the browser's existing subscription picks widget changes
 * up with no new transport — the stack refreshes the same way a new message does.
 */
export const CHAT_WIDGET_CHANGED = 'chat.widget_changed'

/** What happened to a widget. Named so a subscriber can tell apart the reasons. */
export type ChatWidgetChange = 'raised' | 'answered' | 'dismissed' | 'reordered'
