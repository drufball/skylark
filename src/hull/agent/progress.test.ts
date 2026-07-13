import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import {
  backgroundToolLabel,
  chatProgressLine,
  issuesProgressLine,
  isTurnBoundary,
  toolExecutionDetail,
  truncate,
} from './progress'

describe('truncate', () => {
  it('leaves short text unchanged', () => {
    expect(truncate('hello', 120)).toBe('hello')
  })

  it('truncates long text to max - 1 and appends …', () => {
    const text = 'x'.repeat(200)
    const result = truncate(text, 120)
    expect(result.length).toBe(120)
    expect(result).toMatch(/…$/)
    expect(result).toBe('x'.repeat(119) + '…')
  })

  it('defaults to max=120', () => {
    const text = 'x'.repeat(200)
    const result = truncate(text)
    expect(result.length).toBe(120)
  })
})

describe('toolExecutionDetail', () => {
  it('extracts tool name and command arg', () => {
    const detail = toolExecutionDetail({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'npm run check' },
    } as unknown as AgentSessionEvent)
    expect(detail).toEqual({ name: 'bash', detail: 'npm run check' })
  })

  it('falls back to JSON for args without a command', () => {
    const detail = toolExecutionDetail({
      type: 'tool_execution_start',
      toolName: 'read',
      args: { path: '/foo' },
    } as unknown as AgentSessionEvent)
    expect(detail?.name).toBe('read')
    expect(detail?.detail).toContain('path')
  })

  it('handles string args directly', () => {
    const detail = toolExecutionDetail({
      type: 'tool_execution_start',
      toolName: 'example',
      args: 'plain string arg',
    } as unknown as AgentSessionEvent)
    expect(detail).toEqual({ name: 'example', detail: 'plain string arg' })
  })

  it('returns null for non-tool events', () => {
    expect(
      toolExecutionDetail({ type: 'turn_end' } as AgentSessionEvent),
    ).toBeNull()
  })
})

describe('isTurnBoundary', () => {
  it('returns true for turn_end and agent_end', () => {
    expect(isTurnBoundary({ type: 'turn_end' } as AgentSessionEvent)).toBe(true)
    expect(isTurnBoundary({ type: 'agent_end' } as AgentSessionEvent)).toBe(
      true,
    )
  })

  it('returns false for other events', () => {
    expect(
      isTurnBoundary({
        type: 'tool_execution_start',
        toolName: 'bash',
      } as unknown as AgentSessionEvent),
    ).toBe(false)
    expect(
      isTurnBoundary({
        type: 'message_update',
      } as unknown as AgentSessionEvent),
    ).toBe(false)
  })
})

describe('backgroundToolLabel', () => {
  it('extracts the label from a background tool_execution_start', () => {
    expect(
      backgroundToolLabel({
        type: 'tool_execution_start',
        toolName: 'background',
        args: { label: 'PR #12 CI' },
      } as unknown as AgentSessionEvent),
    ).toBe('PR #12 CI')
  })

  it('falls back to a generic phrase when the label is missing or blank', () => {
    expect(
      backgroundToolLabel({
        type: 'tool_execution_start',
        toolName: 'background',
        args: {},
      } as unknown as AgentSessionEvent),
    ).toBe('a background job')
  })

  it('is null for any other tool, or a non-tool event', () => {
    expect(
      backgroundToolLabel({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: {},
      } as unknown as AgentSessionEvent),
    ).toBeNull()
    expect(
      backgroundToolLabel({ type: 'turn_end' } as AgentSessionEvent),
    ).toBeNull()
  })
})

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
    const result = issuesProgressLine({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'npm run check' },
    } as unknown as AgentSessionEvent)
    expect(result?.line).toMatch(/bash/)
    expect(result?.line).toMatch(/npm run check/)
    expect(result?.awaitingBackground).toBe(false)
  })

  it('reports a turn boundary as thinking/working', () => {
    expect(
      issuesProgressLine({ type: 'turn_end' } as AgentSessionEvent),
    ).toEqual({ line: 'thinking…', awaitingBackground: false })
    expect(
      issuesProgressLine({ type: 'agent_end' } as AgentSessionEvent),
    ).toEqual({ line: 'thinking…', awaitingBackground: false })
  })

  it('marks a background tool call as awaiting, with its label in the line', () => {
    const result = issuesProgressLine({
      type: 'tool_execution_start',
      toolName: 'background',
      args: { command: 'gh pr checks --watch', label: 'PR #12 CI' },
    } as unknown as AgentSessionEvent)
    expect(result?.awaitingBackground).toBe(true)
    expect(result?.line).toMatch(/PR #12 CI/)
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
    const result = issuesProgressLine({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'x'.repeat(300) },
    } as unknown as AgentSessionEvent)
    expect(result).not.toBeNull()
    expect((result?.line ?? '').length).toBeLessThanOrEqual(120)
    expect(result?.line).toMatch(/…$/)
  })

  it('handles a tool event with no command arg', () => {
    const result = issuesProgressLine({
      type: 'tool_execution_start',
      toolName: 'read',
      args: { path: 'x' },
    } as unknown as AgentSessionEvent)
    expect(result?.line).toMatch(/read/)
  })
})
