import { errorMessage } from '@hull/lib/errors'

/**
 * The bridge from notifications to a sleeping agent: when an inbox row lands
 * for an agent crew member, wake it — run a turn in the chat its work belongs
 * to, briefed on everything unread. This is what closes the planning loop: the
 * chat agent files an issue (`--chat` records the conversation), the builder
 * moves it, the creator's auto-watch notifies it, and the waker brings the
 * agent back to review and file the next piece.
 *
 * Debounced per agent: a flurry of notifications (a build landing touches
 * status + comments in quick succession) becomes ONE wake with the whole batch
 * briefed, not a session per ping. If a turn is already running, the runtime
 * queues the wake prompt as a follow-up — a second, in-flight debounce.
 *
 * Everything is injected (reads, the wake itself, even the timer) so the
 * decisions test without a runtime, a database, or real time.
 */

/** The slice of a notification the waker routes and briefs on. */
export interface WakeableNotification {
  userId: string
  topic: string
  type: string
  payload: unknown
  actorId: string | null
}

export interface AgentWakerDeps {
  /** Is this user an agent? Humans read their inbox; agents get woken. */
  isAgent(userId: string): Promise<boolean>
  /** The user's unread notifications, oldest first. */
  listUnread(userId: string): Promise<WakeableNotification[]>
  /** Consume them — the wake briefing is their delivery. */
  markAllRead(userId: string): Promise<void>
  /** The chat a topic's work belongs to (an issue's originChatId), if any. */
  chatForTopic(topic: string): Promise<string | null>
  /** One line of briefing copy per notification. */
  describe(notification: WakeableNotification): Promise<string>
  /** Wake the agent in a chat with a briefing (the orchestrator's wake). */
  wake(chatId: string, agentUserId: string, briefing: string): Promise<void>
  /** How long to gather a flurry before waking. */
  debounceMs: number
}

/** Compose the wake briefing from the batch's lines. */
export function wakeBriefing(lines: string[]): string {
  const plural = lines.length === 1 ? 'update' : 'updates'
  return `${String(lines.length)} ${plural} on work you're watching:
${lines.map((l) => `- ${l}`).join('\n')}

Review what happened. If work landed, check the result; file follow-up issues
for anything wrong, and kick off the next piece if there is one. Reply here
with a short update for the crew.`
}

export function createAgentWaker(deps: AgentWakerDeps): {
  onNotified(notification: WakeableNotification): void
} {
  // One pending timer per agent — the debounce window.
  const pending = new Map<string, ReturnType<typeof setTimeout>>()

  async function fire(userId: string): Promise<void> {
    pending.delete(userId)
    if (!(await deps.isAgent(userId))) return

    const unread = await deps.listUnread(userId)
    if (unread.length === 0) return
    await deps.markAllRead(userId)

    // Group the batch by the chat its work belongs to; notifications whose
    // topic resolves to no chat have nowhere to wake — they stay readable in
    // the inbox (already marked read here; by design, the briefing IS their
    // delivery for agents).
    const byChat = new Map<string, WakeableNotification[]>()
    for (const notification of unread) {
      const chatId = await deps.chatForTopic(notification.topic)
      if (!chatId) continue
      const batch = byChat.get(chatId) ?? []
      batch.push(notification)
      byChat.set(chatId, batch)
    }

    for (const [chatId, batch] of byChat) {
      const lines = await Promise.all(batch.map((n) => deps.describe(n)))
      await deps.wake(chatId, userId, wakeBriefing(lines))
    }
  }

  return {
    onNotified(notification) {
      if (pending.has(notification.userId)) return // a wake is already gathering
      const timer = setTimeout(() => {
        void fire(notification.userId).catch((err: unknown) => {
          console.error(`agent wake failed: ${errorMessage(err)}`)
        })
      }, deps.debounceMs)
      timer.unref()
      pending.set(notification.userId, timer)
    },
  }
}
