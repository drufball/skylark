import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import { chatProgressLine, issuesProgressLine } from './progress'

describe('chatProgressLine', () => {
  it('surfaces tool steps only — never a line per delta', () => {
    expect(
      chatProgressLine({
        type: 'tool_execution_start',
        toolName: 'read',
      } as unknown as AgentSessionEvent),
    ).toBe('using read…')
    // Everything else is quiet, so a turn's stream of deltas can't flood the log.
    expect(
      chatProgressLine({
        type: 'message_update',
      } as unknown as AgentSessionEvent),
    ).toBeNull()
    expect(
      chatProgressLine({ type: 'turn_end' } as AgentSessionEvent),
    ).toBeNull()
  })
})

describe('issuesProgressLine', () => {
  it('summarizes a tool execution with command detail', () => {
    const line = issuesProgressLine({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'npm run check' },
    } as unknown as AgentSessionEvent)
    expect(line).toMatch(/bash/)
    expect(line).toMatch(/npm run check/)
  })

  it('reports a turn boundary as thinking/working', () => {
    expect(issuesProgressLine({ type: 'turn_end' } as AgentSessionEvent)).toBe(
      'thinking…',
    )
    expect(issuesProgressLine({ type: 'agent_end' } as AgentSessionEvent)).toBe(
      'thinking…',
    )
  })

  it('returns null for events that carry no progress worth showing', () => {
    expect(
      issuesProgressLine({
        type: 'queue_update',
        steering: [],
        followUp: [],
      } as unknown as AgentSessionEvent),
    ).toBeNull()
  })

  it('truncates a very long tool line to ~120 chars', () => {
    const line = issuesProgressLine({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'x'.repeat(300) },
    } as unknown as AgentSessionEvent)
    expect(line).not.toBeNull()
    expect((line ?? '').length).toBeLessThanOrEqual(120)
    expect(line).toMatch(/…$/)
  })

  it('handles a tool event with no command arg', () => {
    const line = issuesProgressLine({
      type: 'tool_execution_start',
      toolName: 'read',
      args: { path: 'x' },
    } as unknown as AgentSessionEvent)
    expect(line).toMatch(/read/)
    // No command detail, but still a valid line
    expect(line).toBeTruthy()
  })
})
