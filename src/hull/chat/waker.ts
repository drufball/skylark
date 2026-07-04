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
 * briefed, not a session per ping. While a wake is being DELIVERED (fire is
 * mid-flight), new notifications don't arm a competing timer — they're noted,
 * and delivery finishing arms one fresh debounce window for whatever landed
 * meanwhile. One wake in flight, never two, and nothing silently dropped.
 *
 * Consumption follows delivery: a batch is marked read only AFTER its wake
 * succeeds, so a failed wake leaves the rows unread and the next notification
 * retries the whole backlog. Notifications with no route home (a topic with no
 * origin chat) are consumed without a wake — for an agent the inbox has no
 * other reader.
 *
 * Everything is injected (reads, the wake itself, even the timer) so the
 * decisions test without a runtime, a database, or real time.
 */

/** The slice of a notification the waker routes and briefs on. */
export interface WakeableNotification {
  id: string
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
  /** Consume delivered entries — called per batch, after its wake succeeds. */
  markRead(userId: string, ids: string[]): Promise<void>
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
  // Agents whose fire is mid-delivery — no competing timer may arm meanwhile.
  const inFlight = new Set<string>()
  // Agents that got a notification DURING delivery: fire re-arms them when it
  // finishes, so nothing is dropped — it just waits for the next window.
  const arrivedDuringFire = new Set<string>()

  function arm(userId: string): void {
    const timer = setTimeout(() => {
      void fire(userId).catch((err: unknown) => {
        console.error(`agent wake failed: ${errorMessage(err)}`)
      })
    }, deps.debounceMs)
    timer.unref()
    pending.set(userId, timer)
  }

  async function fire(userId: string): Promise<void> {
    pending.delete(userId)
    inFlight.add(userId)
    try {
      if (!(await deps.isAgent(userId))) {
        return
      }

      const unread = await deps.listUnread(userId)
      if (unread.length === 0) {
        return
      }

      // Group the batch by the chat its work belongs to.
      const routable = new Map<string, WakeableNotification[]>()
      const orphans: WakeableNotification[] = []
      for (const notification of unread) {
        const chatId = await deps.chatForTopic(notification.topic)
        if (!chatId) {
          orphans.push(notification)
          continue
        }
        const batch = routable.get(chatId) ?? []
        batch.push(notification)
        routable.set(chatId, batch)
      }

      // No route home → no wake to deliver; consume so they don't pile up (an
      // agent's inbox has no other reader).
      await deps.markRead(
        userId,
        orphans.map((n) => n.id),
      )

      // Deliver per chat, consuming each batch only once its wake succeeded — a
      // failed wake leaves its rows unread for the next notification to retry.
      for (const [chatId, batch] of routable) {
        const lines = await Promise.all(batch.map((n) => deps.describe(n)))
        await deps.wake(chatId, userId, wakeBriefing(lines))
        await deps.markRead(
          userId,
          batch.map((n) => n.id),
        )
      }
    } finally {
      inFlight.delete(userId)
      // Notifications that landed while we were delivering start a fresh
      // window now — on success AND on failure, so a wedged wake can't
      // strand them.
      if (arrivedDuringFire.delete(userId)) arm(userId)
    }
  }

  return {
    onNotified(notification) {
      if (inFlight.has(notification.userId)) {
        arrivedDuringFire.add(notification.userId)
        return // delivery in flight — fire will re-arm for this on finish
      }
      if (pending.has(notification.userId)) return // a wake is already gathering
      arm(notification.userId)
    },
  }
}
