// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hull/health/server', () => ({
  getBehindOrigin: vi.fn(),
}))

import { getBehindOrigin } from '@hull/health/server'

import { useBehindOrigin } from './use-behind-origin'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useBehindOrigin', () => {
  it('starts at null and picks up the fetched count once it resolves', async () => {
    vi.mocked(getBehindOrigin).mockResolvedValue(3)

    const { result } = renderHook(() => useBehindOrigin())
    expect(result.current).toBeNull()

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current).toBe(3)
    expect(getBehindOrigin).toHaveBeenCalledOnce()
  })

  it('polls again after the interval elapses', async () => {
    vi.mocked(getBehindOrigin).mockResolvedValue(1)

    renderHook(() => useBehindOrigin(60_000))
    await act(async () => {
      await Promise.resolve()
    })
    expect(getBehindOrigin).toHaveBeenCalledOnce()

    vi.mocked(getBehindOrigin).mockResolvedValue(2)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
      await Promise.resolve()
    })

    expect(getBehindOrigin).toHaveBeenCalledTimes(2)
  })

  it('degrades to null instead of throwing when the door rejects', async () => {
    vi.mocked(getBehindOrigin).mockRejectedValue(new Error('offline'))

    const { result } = renderHook(() => useBehindOrigin())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current).toBeNull()
  })

  it('stops polling after unmount', async () => {
    vi.mocked(getBehindOrigin).mockResolvedValue(1)

    const { unmount } = renderHook(() => useBehindOrigin(60_000))
    await act(async () => {
      await Promise.resolve()
    })
    expect(getBehindOrigin).toHaveBeenCalledOnce()

    unmount()
    await act(async () => {
      vi.advanceTimersByTime(120_000)
      await Promise.resolve()
    })

    expect(getBehindOrigin).toHaveBeenCalledOnce()
  })
})
