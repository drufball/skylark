import { describe, expect, it, vi } from 'vitest'

import { BEHIND_ORIGIN_CACHE_MS, behindOrigin } from './behind-origin'

describe('behindOrigin', () => {
  it('fetches fresh when there is no cache yet', async () => {
    const cache: { current?: { behind: number | null; fetchedAt: number } } = {}
    const fetchBehindCount = vi.fn().mockResolvedValue(3)

    const result = await behindOrigin(
      { now: () => 1000, fetchBehindCount },
      cache,
    )

    expect(result).toBe(3)
    expect(fetchBehindCount).toHaveBeenCalledOnce()
    expect(cache.current).toEqual({ behind: 3, fetchedAt: 1000 })
  })

  it('reuses the cached count inside the cache window, without re-fetching', async () => {
    const cache = { current: { behind: 5, fetchedAt: 1000 } }
    const fetchBehindCount = vi.fn().mockResolvedValue(99)

    const result = await behindOrigin(
      { now: () => 1000 + BEHIND_ORIGIN_CACHE_MS - 1, fetchBehindCount },
      cache,
    )

    expect(result).toBe(5)
    expect(fetchBehindCount).not.toHaveBeenCalled()
  })

  it('fetches again once the cache window has passed', async () => {
    const cache = { current: { behind: 5, fetchedAt: 1000 } }
    const fetchBehindCount = vi.fn().mockResolvedValue(7)
    const now = 1000 + BEHIND_ORIGIN_CACHE_MS

    const result = await behindOrigin(
      { now: () => now, fetchBehindCount },
      cache,
    )

    expect(result).toBe(7)
    expect(fetchBehindCount).toHaveBeenCalledOnce()
    expect(cache.current).toEqual({ behind: 7, fetchedAt: now })
  })

  it('reports unknown (null) when the git check rejects, without throwing', async () => {
    const cache: { current?: { behind: number | null; fetchedAt: number } } = {}
    const fetchBehindCount = vi
      .fn()
      .mockRejectedValue(new Error('fatal: unable to access origin'))

    const result = await behindOrigin(
      { now: () => 1000, fetchBehindCount },
      cache,
    )

    expect(result).toBeNull()
    expect(cache.current).toEqual({ behind: null, fetchedAt: 1000 })
  })

  it('reports unknown for a non-Error rejection too', async () => {
    const cache: { current?: { behind: number | null; fetchedAt: number } } = {}
    // Rejecting with a bare string (not wrapped in an Error) is the whole
    // point of this test — a driver doesn't always reject with an Error.
    const fetchBehindCount = vi.fn().mockRejectedValue('kraken')

    const result = await behindOrigin(
      { now: () => 1000, fetchBehindCount },
      cache,
    )

    expect(result).toBeNull()
  })

  it('re-fetches after an unknown result once the window passes (does not stick forever)', async () => {
    const cache = { current: { behind: null, fetchedAt: 1000 } }
    const fetchBehindCount = vi.fn().mockResolvedValue(2)
    const now = 1000 + BEHIND_ORIGIN_CACHE_MS

    const result = await behindOrigin(
      { now: () => now, fetchBehindCount },
      cache,
    )

    expect(result).toBe(2)
    expect(fetchBehindCount).toHaveBeenCalledOnce()
  })

  it('defaults to the module-level cache when none is passed, so a live process shares one answer', async () => {
    const fetchBehindCount = vi.fn().mockResolvedValue(1)

    const result = await behindOrigin({
      now: () => Date.now(),
      fetchBehindCount,
    })

    expect(result).toBe(1)
  })
})
