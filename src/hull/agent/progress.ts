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
 * Translate an AgentSessionEvent into a short progress line for the issues
 * board's status display. Surfaces tool execution with command detail (truncated
 * to ~120 chars) plus turn boundaries with "thinking…".
 *
 * Issues shows more detail than chat because the status line is the primary
 * progress indicator for background builds (no live streamed transcript), while
 * chat has the full conversation visible.
 */
export function issuesProgressLine(event: AgentSessionEvent): string | null {
  const tool = toolExecutionDetail(event)
  if (tool) return truncate(`🔧 ${tool.name} ${tool.detail}`.trim())
  if (isTurnBoundary(event)) return 'thinking…'
  return null
}
