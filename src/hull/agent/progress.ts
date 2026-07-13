import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

/**
 * Event primitives: neutral helpers that extract structure from AgentSessionEvent.
 * These are the building blocks; consumers (chat, issues, CLI) compose them into
 * their own display policy.
 */

/** Truncate text to a maximum length, appending … if trimmed. */
export function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Extract tool execution detail from a tool_execution_start event.
 * Returns { name, detail } where detail is the command arg if present,
 * otherwise a JSON stringification of the args.
 */
export function toolExecutionDetail(event: AgentSessionEvent): {
  name: string
  detail: string
} | null {
  if (event.type !== 'tool_execution_start') return null
  const args: unknown = event.args
  const detail =
    typeof args === 'object' && args && 'command' in args
      ? String(args.command)
      : typeof args === 'string'
        ? args
        : JSON.stringify(args)
  return { name: event.toolName, detail }
}

/** Is this event a turn boundary (turn_end or agent_end)? */
export function isTurnBoundary(event: AgentSessionEvent): boolean {
  return event.type === 'turn_end' || event.type === 'agent_end'
}

/**
 * If this event is the START of a `background` tool call, return its label
 * (falling back to a generic phrase if the label arg is missing/blank) —
 * the one signal (see `background-tool.ts`) that a turn is about to end ON
 * PURPOSE to await a long-running command, rather than because the agent
 * simply stopped. Null for every other event, including other tools. Callers
 * use this to mark a progress line as "awaiting a background job" rather
 * than a plain turn boundary, so a stalled session (the job's resume never
 * fires) can eventually be told apart from one legitimately mid-turn (see
 * issue #4mna).
 */
export function backgroundToolLabel(event: AgentSessionEvent): string | null {
  if (event.type !== 'tool_execution_start') return null
  if (event.toolName !== 'background') return null
  const args: unknown = event.args
  const label =
    typeof args === 'object' && args !== null && 'label' in args
      ? args.label
      : undefined
  return typeof label === 'string' && label ? label : 'a background job'
}

/**
 * Consumer-specific formatters: compose the primitives into progress lines.
 */

/**
 * Translate an AgentSessionEvent into a short progress line for chat's
 * "working…" placeholder. Returns a line only on tool execution events — never
 * per delta — so a turn emits a handful of progress events, not one per
 * streamed token.
 *
 * Chat surfaces tool steps only, never turn boundaries (deliberate earlier fix
 * to avoid flooding the durable log with ticks).
 */
export function chatProgressLine(event: AgentSessionEvent): string | null {
  const tool = toolExecutionDetail(event)
  if (tool) return `using ${tool.name}…`
  return null
}

/**
 * Translate an AgentSessionEvent into a progress line for the issues board's
 * status display, PLUS whether this line marks a turn ending on purpose to
 * await a background job (`awaitingBackground`) — the durable flag the
 * orchestrator writes alongside the line (`issues.awaitingBackground`) so the
 * board/thread can tell "the agent is deliberately waiting on a job" apart
 * from a plain turn boundary that just... stopped ticking (see issue #4mna).
 * Every other progress line (a tool step, a bare turn boundary) resets the
 * flag to false, so a resumed session's next real tick clears it.
 *
 * Surfaces tool execution with command detail (truncated to ~120 chars) plus
 * turn boundaries with "thinking…". Issues shows more detail than chat
 * because the status line is the primary progress indicator for background
 * builds (no live streamed transcript), while chat has the full conversation
 * visible.
 */
export interface IssueProgressLine {
  line: string
  awaitingBackground: boolean
}

export function issuesProgressLine(
  event: AgentSessionEvent,
): IssueProgressLine | null {
  const backgroundLabel = backgroundToolLabel(event)
  if (backgroundLabel) {
    return {
      line: truncate(`⏳ waiting on ${backgroundLabel}…`),
      awaitingBackground: true,
    }
  }
  const tool = toolExecutionDetail(event)
  if (tool) {
    return {
      line: truncate(`🔧 ${tool.name} ${tool.detail}`.trim()),
      awaitingBackground: false,
    }
  }
  if (isTurnBoundary(event))
    return { line: 'thinking…', awaitingBackground: false }
  return null
}
