import { describe, expect, it, vi } from 'vitest'

import type { BackgroundJobs } from './background'
import { createBackgroundTool } from './background-tool'

/** A jobs stand-in that records start() calls and hands back a fixed id. */
function fakeJobs(): BackgroundJobs & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    start: (input) => {
      calls.push(input)
      return Promise.resolve('job-1')
    },
    cancelForSession: vi.fn(),
  }
}

describe('createBackgroundTool', () => {
  it('starts a job scoped to the session/cwd and ends the turn', async () => {
    const jobs = fakeJobs()
    const tool = createBackgroundTool('sess-1', '/wt/branch', jobs)

    expect(tool.name).toBe('background')

    const result = await tool.execute(
      'call-1',
      { command: 'gh pr checks 12 --watch', label: 'PR #12 CI' },
      undefined,
      undefined,
      // ctx is unused by this tool
      undefined as never,
    )

    // The job was started with the session's id + cwd. No check-in override was
    // given, so the interval is null → the watch's default applies.
    expect(jobs.calls).toEqual([
      {
        sessionId: 'sess-1',
        command: 'gh pr checks 12 --watch',
        label: 'PR #12 CI',
        cwd: '/wt/branch',
        checkInIntervalMs: null,
      },
    ])

    // It tells the agent to stop — `terminate` ends the turn so the session can
    // be cleanly re-invoked when the job finishes.
    expect(result.terminate).toBe(true)
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('')
    expect(text).toContain('PR #12 CI')
    expect(text).toContain('job-1')
  })

  it('converts a positive check-in override from minutes to ms on the row', async () => {
    const jobs = fakeJobs()
    const tool = createBackgroundTool('sess-1', '/wt', jobs)

    await tool.execute(
      'call-1',
      { command: 'long build', label: 'slow', checkInMinutes: 30 },
      undefined,
      undefined,
      undefined as never,
    )

    expect(
      (jobs.calls[0] as { checkInIntervalMs: number }).checkInIntervalMs,
    ).toBe(30 * 60_000)
  })

  it('ignores a non-positive check-in override (falls back to the default)', async () => {
    const jobs = fakeJobs()
    const tool = createBackgroundTool('sess-1', '/wt', jobs)

    await tool.execute(
      'call-1',
      { command: 'x', label: 'y', checkInMinutes: 0 },
      undefined,
      undefined,
      undefined as never,
    )

    expect(
      (jobs.calls[0] as { checkInIntervalMs: number | null }).checkInIntervalMs,
    ).toBeNull()
  })

  it('advertises itself to the model via prompt guidance', () => {
    const tool = createBackgroundTool('s', '/', fakeJobs())
    expect(tool.promptSnippet).toBeTruthy()
    expect(tool.promptGuidelines?.[0]).toMatch(/background/i)
  })
})
