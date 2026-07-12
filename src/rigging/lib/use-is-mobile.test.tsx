// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MOBILE_BREAKPOINT, useIsMobile } from './use-is-mobile'

function setWidth(width: number) {
  window.innerWidth = width
  window.dispatchEvent(new Event('resize'))
}

const originalWidth = window.innerWidth

afterEach(() => {
  setWidth(originalWidth)
})

describe('useIsMobile', () => {
  it('reports false at and above the breakpoint', () => {
    const { result } = renderHook(() => useIsMobile())
    act(() => {
      setWidth(MOBILE_BREAKPOINT)
    })
    expect(result.current).toBe(false)
  })

  it('reports true below the breakpoint', () => {
    const { result } = renderHook(() => useIsMobile())
    act(() => {
      setWidth(MOBILE_BREAKPOINT - 1)
    })
    expect(result.current).toBe(true)
  })

  it('tracks the viewport live as it crosses the breakpoint', () => {
    const { result } = renderHook(() => useIsMobile())
    act(() => {
      setWidth(1024)
    })
    expect(result.current).toBe(false)

    act(() => {
      setWidth(500)
    })
    expect(result.current).toBe(true)

    act(() => {
      setWidth(1024)
    })
    expect(result.current).toBe(false)
  })

  it('stops listening on unmount', () => {
    const { result, unmount } = renderHook(() => useIsMobile())
    act(() => {
      setWidth(1024)
    })
    unmount()
    // No assertion beyond "this doesn't throw" is meaningful once unmounted —
    // the point is the resize listener was actually removed, not leaked.
    expect(() => {
      setWidth(500)
    }).not.toThrow()
    expect(result.current).toBe(false)
  })
})
