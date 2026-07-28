// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type { BoardIssue } from '@hull/issues/server'
import type { EventSourceLike } from '@rigging/lib/use-ship-log'

vi.mock('@hull/issues/server', () => ({ listBoard: vi.fn() }))
import { listBoard } from '@hull/issues/server'

import { WidgetStack, type WidgetItem } from './stack'

// The shelf above the composer. It knows no kind by name — every row goes
// through the registry — and it owns the ONE ship-log subscription every live
// kind rides.

/** A fake EventSource so the live path is driven with no server. */
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

function issue(over: Partial<BoardIssue> = {}): BoardIssue {
  return {
    id: 'i1',
    nano: 'aaaa',
    title: 'Widget catalog',
    status: 'open',
    authorHandle: 'dru',
    commentCount: 0,
    statusLine: null,
    statusLineAt: null,
    awaitingBackground: false,
    sessionRunning: false,
    batonHolder: null,
    updatedAt: '2026-07-27T09:00:00.000Z',
    ...over,
  }
}

function widget(over: Partial<WidgetItem> = {}): WidgetItem {
  return {
    id: 'w1',
    kind: 'choice',
    props: { question: 'Ship the new theme?', options: ['Yes', 'No'] },
    createdByHandle: 'tilde',
    answerValue: null,
    ...over,
  }
}

function renderStack(over: Partial<WidgetItem>[] = [{}]) {
  const onAnswerWidget = vi.fn()
  const onDismissWidget = vi.fn()
  const view = render(
    <WidgetStack
      widgets={over.map((o) => widget(o))}
      busy={false}
      onAnswerWidget={onAnswerWidget}
      onDismissWidget={onDismissWidget}
      eventSourceFactory={factory}
    />,
  )
  return { ...view, onAnswerWidget, onDismissWidget }
}

/** jsdom has no scrollIntoView; an opening tile scrolls itself to the top. */
const scrollIntoView = vi.fn()
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView
})
afterEach(cleanup)
beforeEach(() => {
  FakeSource.last = undefined
  FakeSource.opened = 0
  vi.mocked(listBoard).mockReset()
  vi.mocked(listBoard).mockResolvedValue([issue()])
})

describe('WidgetStack: rendering through the registry', () => {
  it('shows each kind’s own headline, compact', () => {
    renderStack([
      { id: 'w1', kind: 'choice' },
      { id: 'w2', kind: 'note', props: { text: '# Standup\nat 09:30' } },
      { id: 'w3', kind: 'issue-list', props: { statuses: ['open'] } },
    ])
    const headlines = screen
      .getAllByTestId('widget-headline')
      .map((el) => el.textContent)
    expect(headlines).toEqual([
      'Ship the new theme?',
      'Standup',
      'Issues · open',
    ])
  })

  it('mounts a kind’s body only once its tile is open', async () => {
    renderStack([
      {
        id: 'w2',
        kind: 'note',
        props: { text: '# Standup\n\nBring the board' },
      },
    ])
    // Only the headline until it's opened — a closed tile reads nothing and
    // (for a live kind) asks no service anything.
    expect(screen.queryByText('Bring the board')).toBeNull()
    fireEvent.click(screen.getByLabelText('Open Standup'))
    expect(await screen.findByText('Bring the board')).toBeTruthy()
  })

  it('expands only one widget at a time, so the shelf can’t swallow the thread', () => {
    renderStack([
      { id: 'w1', props: { question: 'A?', options: ['Ay'] } },
      { id: 'w2', props: { question: 'B?', options: ['Bee'] } },
    ])
    fireEvent.click(screen.getByLabelText('Open A?'))
    expect(screen.getByRole('button', { name: 'Ay' })).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Open B?'))
    expect(screen.queryByRole('button', { name: 'Ay' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Bee' })).toBeTruthy()
  })

  it('answers with the tapped option', () => {
    const { onAnswerWidget } = renderStack()
    fireEvent.click(screen.getByLabelText('Open Ship the new theme?'))
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(onAnswerWidget).toHaveBeenCalledWith('w1', 'No')
  })

  it('answers only once per tap-through, even on a double tap', () => {
    const { onAnswerWidget } = renderStack()
    fireEvent.click(screen.getByLabelText('Open Ship the new theme?'))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onAnswerWidget).toHaveBeenCalledTimes(1)
  })

  it('dismisses a widget', () => {
    const { onDismissWidget } = renderStack()
    fireEvent.click(screen.getByLabelText('Dismiss Ship the new theme?'))
    expect(onDismissWidget).toHaveBeenCalledWith('w1')
  })
})

describe('WidgetStack: a shelf, not a second pane', () => {
  it('caps its height and scrolls, so the thread always stays visible', () => {
    const { container } = renderStack()
    const stack = container.querySelector('[data-testid="widget-stack"]')
    expect(stack?.className).toContain('max-h-')
    expect(stack?.className).toContain('overflow-y-auto')
  })

  it('clamps a long headline to two lines rather than growing the tile', () => {
    renderStack([
      {
        props: {
          question:
            'Should we ship the new theme now, or hold it until the files sweep lands?',
          options: ['Ship', 'Hold'],
        },
      },
    ])
    expect(screen.getByTestId('widget-headline').className).toContain(
      'line-clamp-2',
    )
  })

  it('gives every control a thumb-sized tap target', () => {
    renderStack()
    // 44px is the floor a thumb needs; min-h-11 is 2.75rem = 44px.
    expect(
      screen.getByLabelText('Open Ship the new theme?').className,
    ).toContain('min-h-11')
    expect(
      screen.getByLabelText('Dismiss Ship the new theme?').className,
    ).toContain('min-h-11')
    fireEvent.click(screen.getByLabelText('Open Ship the new theme?'))
    expect(screen.getByRole('button', { name: 'Yes' }).className).toContain(
      'min-h-11',
    )
  })

  it('re-offers the options if the answer did not take', () => {
    // A spent widget normally vanishes because the server says it did. If the
    // answer FAILED, the widget is still in the shelf — and must be answerable
    // again rather than sitting there with dead buttons forever.
    const onAnswerWidget = vi.fn()
    function paint(busy: boolean) {
      return (
        <WidgetStack
          widgets={[widget()]}
          busy={busy}
          onAnswerWidget={onAnswerWidget}
          onDismissWidget={vi.fn()}
          eventSourceFactory={factory}
        />
      )
    }
    const { rerender } = render(paint(false))
    fireEvent.click(screen.getByLabelText('Open Ship the new theme?'))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onAnswerWidget).toHaveBeenCalledTimes(1)

    rerender(paint(true)) // the request is in flight — still spent
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onAnswerWidget).toHaveBeenCalledTimes(1)

    rerender(paint(false)) // it came back, and the widget is STILL here
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onAnswerWidget).toHaveBeenCalledTimes(2)
  })

  it('brings an opening tile to the top of the band', () => {
    // The shelf is height-capped so it can't push the thread off a phone, which
    // meant tapping the third tile opened a body almost entirely below the fold.
    renderStack([
      { id: 'w1', props: { question: 'A?', options: ['Ay'] } },
      { id: 'w2', props: { question: 'B?', options: ['Bee'] } },
      { id: 'w3', props: { question: 'C?', options: ['Cee'] } },
    ])
    scrollIntoView.mockClear()
    fireEvent.click(screen.getByLabelText('Open C?'))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  })

  it('collapses an expanded widget when its header is clicked again', () => {
    renderStack()
    fireEvent.click(screen.getByLabelText('Open Ship the new theme?'))
    fireEvent.click(screen.getByLabelText('Open Ship the new theme?'))
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull()
  })
})

describe('WidgetStack: the honest tiles', () => {
  it('says so when a kind this ship doesn’t know is in the shelf', () => {
    renderStack([{ id: 'w9', kind: 'orrery', props: {} }])
    expect(screen.getByText(/doesn’t know this widget kind/)).toBeTruthy()
    expect(screen.getByText('orrery')).toBeTruthy()
  })

  it('says so when the props don’t parse, naming the field', () => {
    renderStack([{ id: 'w9', kind: 'note', props: { text: 7 } }])
    expect(screen.getByText(/don’t parse/)).toBeTruthy()
    expect(screen.getByText('text must be a non-empty string')).toBeTruthy()
  })

  it('still lets a dud tile be dismissed — never a dead end', () => {
    const { onDismissWidget } = renderStack([
      { id: 'w9', kind: 'orrery', props: {} },
    ])
    fireEvent.click(screen.getByLabelText('Dismiss orrery'))
    expect(onDismissWidget).toHaveBeenCalledWith('w9')
  })

  it('renders the rest of the shelf around a dud', () => {
    renderStack([
      { id: 'w9', kind: 'orrery', props: {} },
      { id: 'w1', kind: 'choice' },
    ])
    expect(screen.getByText('Ship the new theme?')).toBeTruthy()
  })
})

describe('WidgetStack: the one live subscription', () => {
  it('opens no stream at all when nothing on the shelf needs one', () => {
    renderStack([
      { id: 'w1', kind: 'choice' },
      { id: 'w2', kind: 'note', props: { text: 'hi' } },
    ])
    expect(FakeSource.last).toBeUndefined()
  })

  it('subscribes once to the union of its widgets’ declared topics', () => {
    renderStack([
      { id: 'w1', kind: 'issue-list', props: { statuses: ['open'] } },
      { id: 'w2', kind: 'issue-list', props: { statuses: ['done'] } },
      { id: 'w3', kind: 'choice' },
    ])
    // ONE connection for the whole shelf, and the duplicated topic asked for once.
    expect(FakeSource.opened).toBe(1)
    expect(FakeSource.last?.url).toBe('/api/stream?topics=issue%3A*')
  })

  it('re-reads a live widget when an event lands on its topic', async () => {
    vi.mocked(listBoard)
      .mockReset()
      .mockResolvedValueOnce([issue({ title: 'Before' })])
      .mockResolvedValueOnce([issue({ title: 'After' })])
    renderStack([{ id: 'w1', kind: 'issue-list', props: {} }])
    fireEvent.click(screen.getByLabelText('Open Issues · all'))
    expect(await screen.findByText('Before')).toBeTruthy()
    act(() => {
      FakeSource.last?.emit()
    })
    expect(await screen.findByText('After')).toBeTruthy()
  })

  it('does not re-read a live widget just because the shelf re-rendered', async () => {
    // Each `parse` hands back a FRESH body closure, and React treats a new
    // component identity as a different component — so an unmemoised resolution
    // would remount the body and re-read the service on every expand, `busy`
    // flip and revision bump, throwing away what it had just fetched.
    // The same rows across re-renders, which is what the route hands over: its
    // `props` come straight off loader data, whose identity only changes when
    // the loader actually re-runs.
    const rows = [widget({ id: 'w1', kind: 'issue-list', props: {} })]
    function paint(busy: boolean) {
      return (
        <WidgetStack
          widgets={rows}
          busy={busy}
          onAnswerWidget={vi.fn()}
          onDismissWidget={vi.fn()}
          eventSourceFactory={factory}
        />
      )
    }
    const { rerender } = render(paint(false))
    fireEvent.click(screen.getByLabelText('Open Issues · all'))
    expect(await screen.findByText('Widget catalog')).toBeTruthy()
    expect(vi.mocked(listBoard)).toHaveBeenCalledTimes(1)

    rerender(paint(true))
    rerender(paint(false))
    expect(await screen.findByText('Widget catalog')).toBeTruthy()
    expect(vi.mocked(listBoard)).toHaveBeenCalledTimes(1)
  })

  it('closes the stream when the shelf unmounts', () => {
    const { unmount } = renderStack([
      { id: 'w1', kind: 'issue-list', props: {} },
    ])
    const source = FakeSource.last
    unmount()
    expect(source?.closed).toBe(true)
  })
})
