// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useShipLogInvalidate } from './use-ship-log-invalidate'

// Mock the dependencies
vi.mock('./use-ship-log', () => ({
  useShipLog: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(),
}))

import { useShipLog, type ShipLogEvent } from './use-ship-log'
import { useRouter } from '@tanstack/react-router'

describe('useShipLogInvalidate', () => {
  let mockInvalidate: ReturnType<typeof vi.fn>
  let capturedCallback: ((event: ShipLogEvent) => void) | undefined

  beforeEach(() => {
    mockInvalidate = vi.fn(() => Promise.resolve())
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    vi.mocked(useRouter).mockReturnValue({
      invalidate: mockInvalidate,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    vi.mocked(useShipLog).mockImplementation((_topics, callback) => {
      capturedCallback = callback
    })
  })

  it('subscribes to ship log topics and invalidates on events', () => {
    const topics = ['test:topic']
    renderHook(() => {
      useShipLogInvalidate(topics)
    })

    // Should have subscribed to the topics
    expect(useShipLog).toHaveBeenCalledWith(topics, expect.any(Function))
  })

  it('calls router.invalidate when an event arrives', () => {
    const topics = ['test:topic']
    renderHook(() => {
      useShipLogInvalidate(topics)
    })

    // Simulate an event
    expect(capturedCallback).toBeDefined()
    if (capturedCallback) {
      const mockEvent: ShipLogEvent = {
        id: '1',
        type: 'test:event',
        source: 'test',
        payload: {},
      }
      capturedCallback(mockEvent)
    }

    expect(mockInvalidate).toHaveBeenCalledOnce()
  })

  it('handles multiple topics', () => {
    const topics = ['topic:one', 'topic:two', 'pattern:*']
    renderHook(() => {
      useShipLogInvalidate(topics)
    })

    expect(useShipLog).toHaveBeenCalledWith(topics, expect.any(Function))
  })

  it('creates stable callback across re-renders', () => {
    const topics = ['test:topic']
    const { rerender } = renderHook(() => {
      useShipLogInvalidate(topics)
    })

    const firstCallback = capturedCallback

    rerender()

    // The callback should be stable (useCallback)
    expect(capturedCallback).toBe(firstCallback)
  })
})
