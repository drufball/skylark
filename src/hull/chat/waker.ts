import { errorMessage } from '@hull/lib/errors'

/**
 * The bridge from notifications to a sleeping agent: when an inbox row lands
 * for an agent crew member, wake it — one turn on the agent's own inbox
 * session, briefed on everything unread. The agent decides for itself which
 * conversation (if any) each update belongs in, and posts there with the chat
 * CLI. This is what closes the planning loop: the chat agent files an issue,
 * the builder moves it, the creator's auto-watch notifies it, and the waker
 * brings the agent back to review and file the next piece.
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
 * retries the whole backlog. Every batch wakes — routing an update to a chat
 * is the agent's own judgment, not the waker's.
 *
 * Everything is injected (reads, the wake itself, even the timer) so the
 * decisions test without a runtime, a database, or real time.
 */

/** The slice of a notification the waker briefs on. */
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
  /** One line of briefing copy per notification. */
  describe(notification: WakeableNotification): Promise<string>
  /** Wake the agent on its inbox session with a briefing (the orchestrator's wake). */
  wake(agentUserId: string, briefing: string): Promise<void>
  /** How long to gather a flurry before waking. */
  debounceMs: number
}

/** Compose the wake briefing from the batch's lines. */
export function wakeBriefing(lines: string[]): string {
  const plural = lines.length === 1 ? 'update' : 'updates'
  return `${String(lines.length)} ${plural} on work you're watching:
${lines.map((l) => `- ${l}`).join('\n')}

Review what happened. If work landed, check the result; file follow-up issues
for anything wrong, and kick off the next piece if there is one. Then decide
which conversation this update belongs in: use the chat CLI to find the chat
where the work was planned and post a concise update there. If no chat fits,
do nothing.`
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

      // ONE wake per agent with the whole backlog briefed, consumed only once
      // the wake succeeded — a failed wake leaves the rows unread for the next
      // notification to retry.
      const lines = await Promise.all(unread.map((n) => deps.describe(n)))
      await deps.wake(userId, wakeBriefing(lines))
      await deps.markRead(
        userId,
        unread.map((n) => n.id),
      )
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
