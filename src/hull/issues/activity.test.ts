import { describe, expect, it } from 'vitest'

import {
  computeBuildActivity,
  formatStallDuration,
  STALL_AFTER_BACKGROUND_MS,
} from './activity'

const NOW = new Date('2024-01-01T12:00:00.000Z')

function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString()
}

describe('formatStallDuration', () => {
  it('formats sub-hour durations as minutes', () => {
    expect(formatStallDuration(3 * 60_000)).toBe('3m')
    expect(formatStallDuration(59 * 60_000)).toBe('59m')
  })

  it('rounds up to at least 1m so a fresh stall never reads as 0m', () => {
    expect(formatStallDuration(10_000)).toBe('1m')
  })

  it('formats hour-plus durations as "Xh Ym"', () => {
    expect(formatStallDuration(72 * 60_000)).toBe('1h 12m')
  })
})

describe('computeBuildActivity', () => {
  it('returns null when there is no status line yet (nothing has ever ticked)', () => {
    expect(
      computeBuildActivity({
        sessionRunning: false,
        statusLine: null,
        statusLineAt: null,
        awaitingBackground: false,
        now: NOW,
      }),
    ).toBeNull()
  })

  it('busy: the session is running right now, regardless of tick age', () => {
    const result = computeBuildActivity({
      sessionRunning: true,
      statusLine: '🔧 bash npm run check',
      statusLineAt: minutesAgo(999), // stale age must not matter — it's running
      awaitingBackground: false,
      now: NOW,
    })
    expect(result).toEqual({ state: 'busy', label: '🔧 bash npm run check' })
  })

  it('waiting: not running, awaiting a background job, within the trust window', () => {
    const result = computeBuildActivity({
      sessionRunning: false,
      statusLine: '⏳ waiting on PR #12 CI…',
      statusLineAt: minutesAgo(2),
      awaitingBackground: true,
      now: NOW,
    })
    expect(result).toEqual({
      state: 'waiting',
      label: '⏳ waiting on PR #12 CI…',
    })
  })

  it('stalled: not running, no background wait, tick is old — the alarming case', () => {
    const result = computeBuildActivity({
      sessionRunning: false,
      statusLine: 'thinking…',
      statusLineAt: minutesAgo(25),
      awaitingBackground: false,
      now: NOW,
    })
    expect(result?.state).toBe('stalled')
    expect(result?.label).toBe('⚠ stalled 25m')
  })

  it('stalled: a background wait that outlives the trust window flips to stalled too', () => {
    const staleMinutes = STALL_AFTER_BACKGROUND_MS / 60_000 + 5
    const result = computeBuildActivity({
      sessionRunning: false,
      statusLine: '⏳ waiting on PR #12 CI…',
      statusLineAt: minutesAgo(staleMinutes),
      awaitingBackground: true,
      now: NOW,
    })
    expect(result?.state).toBe('stalled')
    expect(result?.label).toMatch(/^⚠ stalled/)
  })

  it('stalled: no statusLineAt at all (pre-migration row) reads as stalled, not waiting', () => {
    const result = computeBuildActivity({
      sessionRunning: false,
      statusLine: 'thinking…',
      statusLineAt: null,
      awaitingBackground: true,
      now: NOW,
    })
    expect(result?.state).toBe('stalled')
  })
})
