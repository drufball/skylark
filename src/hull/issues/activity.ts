/**
 * The board/thread status line can lie: it renders whatever the agent last
 * streamed, with no read on whether anything is actually running right now
 * (see issue #4mna, traced from a real incident — a `background`-tool turn
 * whose resume never fired left "thinking…" on screen for 25+ minutes while
 * nothing was happening). This module is the pure classifier that turns the
 * raw signals into one of three honest states.
 *
 * Inputs, and why each is needed:
 * - `sessionRunning` — is the entrypoint/hand's agent session mid-turn RIGHT
 *   NOW, in this process (`agent_sessions.status === 'running'`, resolved by
 *   the door via the agent service's `runningSessionIds`)? This is the only
 *   direct signal that a turn is actively streaming/executing a tool.
 * - `statusLineAt` — when the line was last written (bumped on every progress
 *   tick, not just turn boundaries — see `setStatusLine`). The "last real
 *   activity" clock neither `issues.updatedAt` nor
 *   `agent_sessions.lastMessageAt` could answer before this issue.
 * - `awaitingBackground` — was the LAST tick a turn ending on purpose to await
 *   a `background` job? Distinguishes a deliberate wait from a turn that just
 *   silently stopped ticking.
 *
 * Background-job liveness is NOT tracked durably (`background.ts`'s jobs are
 * an in-process `Set`, no DB row — see the issue's second root-cause gap), so
 * "waiting" can't be told apart from "the job died and nobody's coming back"
 * except by elapsed time. That's a deliberate, documented limitation: past
 * `STALL_AFTER_BACKGROUND_MS`, a "waiting" reads as "stalled" instead — bounded
 * badness rather than an indefinite calm ellipsis.
 */

/** How long a background wait is trusted before it reads as stalled instead. */
export const STALL_AFTER_BACKGROUND_MS = 10 * 60 * 1000 // 10 minutes

export type BuildActivity =
  | { state: 'busy'; label: string }
  | { state: 'waiting'; label: string }
  | { state: 'stalled'; label: string; stalledMs: number }

/** Format a duration for the alarming "stalled" label — "3m", "1h 12m". */
export function formatStallDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.round(ms / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0
    ? `${String(hours)}h ${String(minutes)}m`
    : `${String(minutes)}m`
}

/**
 * Classify a building issue's activity into one of three states. Pure of the
 * clock (`now` is injected) so it's deterministic to test.
 */
export function computeBuildActivity(input: {
  sessionRunning: boolean
  statusLine: string | null
  statusLineAt: string | null
  awaitingBackground: boolean
  now: Date
}): BuildActivity | null {
  if (!input.statusLine) return null

  if (input.sessionRunning) {
    return { state: 'busy', label: input.statusLine }
  }

  const lastTick = input.statusLineAt ? new Date(input.statusLineAt) : null
  const ageMs = lastTick ? input.now.getTime() - lastTick.getTime() : Infinity

  if (input.awaitingBackground && ageMs < STALL_AFTER_BACKGROUND_MS) {
    return { state: 'waiting', label: input.statusLine }
  }

  return {
    state: 'stalled',
    label: `⚠ stalled ${formatStallDuration(ageMs)}`,
    stalledMs: ageMs,
  }
}
