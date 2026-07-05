// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useLogout } from './use-logout'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(),
}))

vi.mock('@hull/auth/server', () => ({
  logout: vi.fn(),
}))

import { useNavigate } from '@tanstack/react-router'
import { logout } from '@hull/auth/server'

describe('useLogout', () => {
  let mockNavigate: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockNavigate = vi.fn(() => Promise.resolve())
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    vi.mocked(useNavigate).mockReturnValue(mockNavigate as any)
    vi.mocked(logout).mockResolvedValue(undefined)
  })

  it('calls the logout door then navigates to /login', async () => {
    const { result } = renderHook(() => useLogout())

    result.current()
    // The effect runs async; flush microtasks.
    await Promise.resolve()
    await Promise.resolve()

    expect(logout).toHaveBeenCalledOnce()
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' })
  })

  it('returns a stable callback across re-renders', () => {
    const { result, rerender } = renderHook(() => useLogout())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
