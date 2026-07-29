// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hull/notifications/server', () => ({
  unreadNotificationCount: vi.fn(),
}))

import { unreadNotificationCount } from '@hull/notifications/server'

import type { EventSourceLike } from './use-ship-log'
import { useUnreadCount } from './use-unread-count'

/** A fake EventSource the test can push frames through, like use-ship-log's own. */
class FakeSource implements EventSourceLike {
  static last: FakeSource | undefined
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeSource.last = this
  }
  emit(): void {
    this.onmessage?.({
      data: JSON.stringify({
        id: '1',
        type: 'notification.created',
        source: 'notifications',
        topic: 'notify:me',
        payload: {},
      }),
    } as MessageEvent<string>)
  }
  close(): void {
    this.closed = true
  }
}
const factory = (url: string) => new FakeSource(url)

afterEach(() => {
  FakeSource.last = undefined
  vi.mocked(unreadNotificationCount).mockReset()
})

describe('useUnreadCount', () => {
  it('starts at null and picks up the fetched count once it resolves', async () => {
    vi.mocked(unreadNotificationCount).mockResolvedValue(3)

    const { result } = renderHook(() => useUnreadCount(factory))
    expect(result.current).toBeNull()

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current).toBe(3)
    expect(unreadNotificationCount).toHaveBeenCalledOnce()
  })

  it('re-reads when a notification event lands on the wildcard topic', async () => {
    vi.mocked(unreadNotificationCount).mockResolvedValue(1)
    renderHook(() => useUnreadCount(factory))
    await act(async () => {
      await Promise.resolve()
    })
    expect(FakeSource.last?.url).toBe(
      `/api/stream?topics=${encodeURIComponent('notify:*')}`,
    )

    vi.mocked(unreadNotificationCount).mockResolvedValue(2)
    await act(async () => {
      FakeSource.last?.emit()
      await Promise.resolve()
    })

    expect(unreadNotificationCount).toHaveBeenCalledTimes(2)
  })

  it('degrades to null instead of throwing when the door rejects', async () => {
    vi.mocked(unreadNotificationCount).mockRejectedValue(new Error('offline'))

    const { result } = renderHook(() => useUnreadCount(factory))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current).toBeNull()
  })

  it('closes the stream on unmount', () => {
    vi.mocked(unreadNotificationCount).mockResolvedValue(0)
    const { unmount } = renderHook(() => useUnreadCount(factory))
    const source = FakeSource.last
    unmount()
    expect(source?.closed).toBe(true)
  })
})
