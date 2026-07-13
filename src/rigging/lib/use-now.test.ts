// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNow } from './use-now'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useNow', () => {
  it('ticks forward on the interval', () => {
    const { result } = renderHook(() => useNow(1000))
    const first = result.current

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.getTime()).toBeGreaterThan(first.getTime())
  })

  it('stops ticking after unmount', () => {
    const { result, unmount } = renderHook(() => useNow(1000))
    const first = result.current
    unmount()

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    // No new render happened post-unmount, so the captured value is frozen.
    expect(result.current.getTime()).toBe(first.getTime())
  })
})
