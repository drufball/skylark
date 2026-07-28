// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(),
}))

import { useRouter } from '@tanstack/react-router'
import { useInvalidatingAction } from './use-invalidating-action'

describe('useInvalidatingAction', () => {
  let invalidate: Mock<() => Promise<void>>

  beforeEach(() => {
    invalidate = vi.fn(() => Promise.resolve())
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(useRouter).mockReturnValue({
      invalidate,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  })

  it('runs the action, then re-runs the loader', async () => {
    const { result } = renderHook(() => useInvalidatingAction())

    const order: string[] = []
    invalidate.mockImplementation(() => {
      order.push('invalidate')
      return Promise.resolve()
    })

    await act(async () => {
      await result.current.act(() => {
        order.push('action')
        return Promise.resolve()
      })
    })

    expect(order).toEqual(['action', 'invalidate'])
  })

  it('passes the action result through', async () => {
    const { result } = renderHook(() => useInvalidatingAction())

    let created: { id: string } | undefined
    await act(async () => {
      created = await result.current.act(() => Promise.resolve({ id: 'p1' }))
    })

    expect(created).toEqual({ id: 'p1' })
  })

  /**
   * The refresh is PART of the action: `busy` must stay on until the loader
   * has re-run, or a control re-arms for the tens of milliseconds the
   * invalidate is in flight and a second tap reaches a door that can only
   * refuse it.
   */
  it('stays busy through the invalidate, not just the door call', async () => {
    const { result } = renderHook(() => useInvalidatingAction())

    let releaseInvalidate: () => void = () => undefined
    invalidate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseInvalidate = resolve
        }),
    )

    let settled = false
    await act(async () => {
      const pending = result.current
        .act(() => Promise.resolve())
        .then(() => {
          settled = true
        })
      // The door has resolved but the invalidate hasn't: still busy, and a
      // second act is ignored rather than reaching the door again.
      await Promise.resolve()
      const second = vi.fn(() => Promise.resolve())
      await result.current.act(second)
      expect(second).not.toHaveBeenCalled()
      expect(settled).toBe(false)

      releaseInvalidate()
      await pending
    })

    expect(settled).toBe(true)
    expect(result.current.busy).toBe(false)
  })

  it('also exposes plain run and busy for actions that refresh differently', async () => {
    const { result } = renderHook(() => useInvalidatingAction())

    let output: string | undefined
    await act(async () => {
      output = await result.current.run(() => Promise.resolve('raw'))
    })

    expect(output).toBe('raw')
    expect(invalidate).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })
})
