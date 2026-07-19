import { afterEach, describe, expect, it, vi } from 'vitest'

import { startIntervalSweep } from './interval-sweep'

/** A fake timer: capture the sweep callback so a test can fire ticks by hand. */
function fakeSchedule() {
  let captured: (() => void) | undefined
  let cancelled = false
  const schedule = (cb: () => void): (() => void) => {
    captured = cb
    return () => {
      cancelled = true
    }
  }
  return {
    schedule,
    tick: () => captured?.(),
    get cancelled() {
      return cancelled
    },
  }
}

describe('startIntervalSweep', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs the tick with the injected clock on each fire', async () => {
    const timer = fakeSchedule()
    const seen: number[] = []
    startIntervalSweep({
      intervalMs: 1000,
      label: 'test',
      now: () => 42,
      schedule: timer.schedule,
      tick: (now) => {
        seen.push(now)
        return Promise.resolve()
      },
    })

    timer.tick()
    timer.tick()
    await Promise.resolve()

    expect(seen).toEqual([42, 42])
  })

  it('swallows and logs a rejected tick rather than throwing', async () => {
    const timer = fakeSchedule()
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    startIntervalSweep({
      intervalMs: 1000,
      label: 'chat schedules',
      schedule: timer.schedule,
      tick: () => Promise.reject(new Error('boom')),
    })

    expect(() => {
      timer.tick()
    }).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('chat schedules: sweep failed: boom'),
    )
  })

  it('returns the timer’s canceller as stop()', () => {
    const timer = fakeSchedule()
    const stop = startIntervalSweep({
      intervalMs: 1000,
      label: 'test',
      schedule: timer.schedule,
      tick: () => Promise.resolve(),
    })
    expect(timer.cancelled).toBe(false)
    stop()
    expect(timer.cancelled).toBe(true)
  })
})
