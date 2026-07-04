// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useServerAction } from './use-server-action'

describe('useServerAction', () => {
  it('returns a busy flag and action wrapper', () => {
    const { result } = renderHook(() => useServerAction())
    expect(result.current.busy).toBe(false)
    expect(typeof result.current.run).toBe('function')
  })

  it('returns to not-busy after action completes', async () => {
    const { result } = renderHook(() => useServerAction())

    expect(result.current.busy).toBe(false)

    await act(async () => {
      await result.current.run(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              resolve('done')
            }, 10),
          ),
      )
    })

    // Back to false after completion
    expect(result.current.busy).toBe(false)
  })

  it('resets busy to false after action completes', async () => {
    const { result } = renderHook(() => useServerAction())

    await act(async () => {
      await result.current.run(() => Promise.resolve('done'))
    })

    expect(result.current.busy).toBe(false)
  })

  it('resets busy to false even if action throws', async () => {
    const { result } = renderHook(() => useServerAction())

    await act(async () => {
      await expect(
        result.current.run(() => Promise.reject(new Error('fail'))),
      ).rejects.toThrow('fail')
    })

    expect(result.current.busy).toBe(false)
  })

  it('passes action result through', async () => {
    const { result } = renderHook(() => useServerAction())

    let output: string | undefined
    await act(async () => {
      output = await result.current.run(() => Promise.resolve('success'))
    })

    expect(output).toBe('success')
  })

  it('prevents concurrent execution when already busy', async () => {
    const { result } = renderHook(() => useServerAction())

    const slowAction = vi.fn(
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    )

    let secondResult: string | undefined
    await act(async () => {
      const first = result.current.run(slowAction)
      // Try to run a second action while first is running (busy is now true)
      secondResult = (await result.current.run(slowAction)) as
        | string
        | undefined
      await first
    })

    // First action should have run, second should return undefined
    expect(slowAction).toHaveBeenCalledTimes(1)
    expect(secondResult).toBeUndefined()
  })
})
