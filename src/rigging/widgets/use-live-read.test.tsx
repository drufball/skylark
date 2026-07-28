// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useLiveRead } from './use-live-read'

// The one fetch/degrade state machine every live kind rides: read on mount and
// again when a dependency (the stack's `revision`) moves, and when a read
// FAILS, keep the last good value and say so — the ship degrades to
// "database: down" rather than crashing, and so does a tile on it.

/** A read the test controls: resolve or reject each call by hand, in order. */
function controlledRead<T>() {
  const settlers: {
    resolve: (value: T) => void
    reject: (reason: Error) => void
  }[] = []
  const read = vi.fn(
    () =>
      new Promise<T>((resolve, reject) => {
        settlers.push({ resolve, reject })
      }),
  )
  return { read, settlers }
}

describe('useLiveRead', () => {
  it('starts empty and holds the value once the read lands', async () => {
    const { result } = renderHook(() =>
      useLiveRead(() => Promise.resolve('a'), [0]),
    )
    expect(result.current).toEqual({ value: null, failed: false })
    await waitFor(() => {
      expect(result.current).toEqual({ value: 'a', failed: false })
    })
  })

  it('reads fresh when a dependency moves, and not when it does not', async () => {
    const read = vi.fn((n: number) => Promise.resolve(`read ${String(n)}`))
    const { result, rerender } = renderHook(
      ({ revision }: { revision: number }) =>
        useLiveRead(() => read(revision), [revision]),
      { initialProps: { revision: 0 } },
    )
    await waitFor(() => {
      expect(result.current.value).toBe('read 0')
    })
    rerender({ revision: 0 })
    expect(read).toHaveBeenCalledTimes(1)
    rerender({ revision: 1 })
    await waitFor(() => {
      expect(result.current.value).toBe('read 1')
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good value and says the read failed', async () => {
    const { read, settlers } = controlledRead<string>()
    const { result, rerender } = renderHook(
      ({ revision }: { revision: number }) => useLiveRead(read, [revision]),
      { initialProps: { revision: 0 } },
    )
    await act(async () => {
      settlers[0].resolve('the good list')
      await Promise.resolve()
    })
    expect(result.current).toEqual({ value: 'the good list', failed: false })

    rerender({ revision: 1 })
    await act(async () => {
      settlers[1].reject(new Error('database: down'))
      await Promise.resolve()
    })
    // Degrade, don't crash: the tile still has something honest to show.
    expect(result.current).toEqual({ value: 'the good list', failed: true })
  })

  it('recovers on the next successful read', async () => {
    const { read, settlers } = controlledRead<string>()
    const { result, rerender } = renderHook(
      ({ revision }: { revision: number }) => useLiveRead(read, [revision]),
      { initialProps: { revision: 0 } },
    )
    await act(async () => {
      settlers[0].reject(new Error('database: down'))
      await Promise.resolve()
    })
    expect(result.current).toEqual({ value: null, failed: true })

    rerender({ revision: 1 })
    await act(async () => {
      settlers[1].resolve('back up')
      await Promise.resolve()
    })
    expect(result.current).toEqual({ value: 'back up', failed: false })
  })

  it('ignores a read that lands after unmount', async () => {
    // The cancelled flag: a settle after teardown must not touch state (React
    // warns about exactly this, and the warning is a real leak).
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const { read, settlers } = controlledRead<string>()
    const { result, unmount } = renderHook(() => useLiveRead(read, [0]))
    unmount()
    await act(async () => {
      settlers[0].resolve('too late')
      await Promise.resolve()
    })
    expect(result.current).toEqual({ value: null, failed: false })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('ignores a rejection that lands after unmount', async () => {
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const { read, settlers } = controlledRead<string>()
    const { result, unmount } = renderHook(() => useLiveRead(read, [0]))
    unmount()
    await act(async () => {
      settlers[0].reject(new Error('database: down'))
      await Promise.resolve()
    })
    expect(result.current).toEqual({ value: null, failed: false })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('takes only the LATEST read when a dependency moves mid-flight', async () => {
    // Revision 0's read is still in the air when revision 1 fires. The stale
    // effect was cleaned up, so its late landing must not overwrite the fresh
    // one.
    const { read, settlers } = controlledRead<string>()
    const { result, rerender } = renderHook(
      ({ revision }: { revision: number }) => useLiveRead(read, [revision]),
      { initialProps: { revision: 0 } },
    )
    rerender({ revision: 1 })
    await act(async () => {
      settlers[1].resolve('fresh')
      settlers[0].resolve('stale')
      await Promise.resolve()
    })
    expect(result.current).toEqual({ value: 'fresh', failed: false })
  })
})
