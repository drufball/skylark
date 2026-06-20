import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

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
  if (event.type === 'tool_execution_start') return `using ${event.toolName}…`
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
  switch (event.type) {
    case 'tool_execution_start': {
      const args: unknown = event.args
      const detail =
        typeof args === 'object' && args && 'command' in args
          ? String(args.command)
          : ''
      const text = `🔧 ${event.toolName} ${detail}`.trim()
      return text.length > 120 ? `${text.slice(0, 119)}…` : text
    }
    case 'turn_end':
    case 'agent_end':
      return 'thinking…'
    default:
      return null
  }
}
