// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  useShipLog,
  type EventSourceLike,
  type ShipLogEvent,
} from './use-ship-log'

/** A fake EventSource that records the url it opened and lets a test push frames. */
class FakeSource implements EventSourceLike {
  static last: FakeSource | undefined
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeSource.last = this
  }
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }
  emitRaw(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>)
  }
  close(): void {
    this.closed = true
  }
}

const factory = (url: string) => new FakeSource(url)

const event = (over: Partial<ShipLogEvent> = {}): ShipLogEvent => ({
  id: '1',
  type: 'agent.message',
  source: 'agent',
  scope: 'session:s1',
  payload: {},
  ...over,
})

afterEach(() => {
  FakeSource.last = undefined
})

describe('useShipLog', () => {
  it('opens a stream for the requested topics and forwards events', () => {
    const onEvent = vi.fn()
    renderHook(() => {
      useShipLog(['session:s1', 'public'], onEvent, factory)
    })

    expect(FakeSource.last?.url).toBe(
      '/api/stream?topics=session%3As1%2Cpublic',
    )
    FakeSource.last?.emit(event({ id: 'a' }))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('opens no connection when there are no topics', () => {
    renderHook(() => {
      useShipLog([], vi.fn(), factory)
    })
    expect(FakeSource.last).toBeUndefined()
  })

  it('ignores a malformed frame without throwing', () => {
    const onEvent = vi.fn()
    renderHook(() => {
      useShipLog(['public'], onEvent, factory)
    })
    expect(() => FakeSource.last?.emitRaw('not json')).not.toThrow()
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('closes the stream on unmount', () => {
    const { unmount } = renderHook(() => {
      useShipLog(['public'], vi.fn(), factory)
    })
    const source = FakeSource.last
    unmount()
    expect(source?.closed).toBe(true)
  })

  it('does not reopen the stream when only the callback identity changes', () => {
    const { rerender } = renderHook(
      ({ cb }: { cb: (e: ShipLogEvent) => void }) => {
        useShipLog(['public'], cb, factory)
      },
      { initialProps: { cb: vi.fn() } },
    )
    const first = FakeSource.last
    rerender({ cb: vi.fn() })
    // Same connection — a new callback closure must not tear it down.
    expect(FakeSource.last).toBe(first)
    expect(first?.closed).toBe(false)
  })

  it('uses the latest callback after a rerender', () => {
    const a = vi.fn()
    const b = vi.fn()
    const { rerender } = renderHook(
      ({ cb }: { cb: (e: ShipLogEvent) => void }) => {
        useShipLog(['public'], cb, factory)
      },
      { initialProps: { cb: a } },
    )
    rerender({ cb: b })
    FakeSource.last?.emit(event())
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
