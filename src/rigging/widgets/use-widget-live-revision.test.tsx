// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import type { EventSourceLike } from '@rigging/lib/use-ship-log'

import { useWidgetLiveRevision } from './use-widget-live-revision'

// The one subscription a surface holds for all its widgets: union the topics
// the resolved kinds declare, subscribe once, bump a counter per event. Coarse
// on purpose — "something changed, read it again".

class FakeSource implements EventSourceLike {
  static last: FakeSource | undefined
  static opened = 0
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeSource.last = this
    FakeSource.opened += 1
  }
  emit(): void {
    this.onmessage?.({
      data: JSON.stringify({
        id: '1',
        type: 'issue.status_changed',
        source: 'issues',
        topic: 'issue:i1',
        payload: {},
      }),
    } as MessageEvent<string>)
  }
  close(): void {
    this.closed = true
  }
}
const factory = (url: string) => new FakeSource(url)

beforeEach(() => {
  FakeSource.last = undefined
  FakeSource.opened = 0
})

describe('useWidgetLiveRevision', () => {
  it('subscribes once to the union of the widgets’ topics, deduped', () => {
    renderHook(() =>
      useWidgetLiveRevision(
        [
          { kind: 'issue-list', props: { statuses: ['open'] } },
          { kind: 'issue-list', props: { statuses: ['done'] } },
          { kind: 'files', props: { path: 'notes.md' } },
        ],
        factory,
      ),
    )
    // ONE connection, and the topic two widgets share asked for once.
    expect(FakeSource.opened).toBe(1)
    expect(FakeSource.last?.url).toBe(
      `/api/stream?topics=${encodeURIComponent('issue:*,file:notes.md')}`,
    )
  })

  it('asks for nothing when no widget needs to stay live', () => {
    renderHook(() =>
      useWidgetLiveRevision(
        [
          { kind: 'choice', props: { question: 'q', options: ['a'] } },
          // A row that doesn't resolve declares no topics either.
          { kind: 'orrery', props: {} },
        ],
        factory,
      ),
    )
    expect(FakeSource.opened).toBe(0)
  })

  it('bumps the revision each time an event lands', () => {
    const { result } = renderHook(() =>
      useWidgetLiveRevision([{ kind: 'issue-list', props: {} }], factory),
    )
    expect(result.current).toBe(0)
    act(() => {
      FakeSource.last?.emit()
    })
    expect(result.current).toBe(1)
    act(() => {
      FakeSource.last?.emit()
    })
    expect(result.current).toBe(2)
  })

  it('closes the stream when the surface unmounts', () => {
    const { unmount } = renderHook(() =>
      useWidgetLiveRevision([{ kind: 'issue-list', props: {} }], factory),
    )
    const source = FakeSource.last
    unmount()
    expect(source?.closed).toBe(true)
  })
})
